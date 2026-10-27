/// The tick never passes its D1 budget: a queue
/// of 60 alerts and an 80-line statement, at the default setting and a tight
/// one, counted by a raw counter UNDER the budget wrapper.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { emptyPlaybook } from "../../src/playbook";
import { publishPlaybook } from "../../src/playbook-store";
import { readWith, workQueue } from "../src/pipeline";
import { AlertSchema } from "../src/schemas";
import { runTick, type Step } from "../src/tick";
import { FakeClaude, MODELS } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { exactCountingDb, makeDeps, makeEnv } from "./helpers/harness";

const PDF = new Uint8Array(readFileSync(new URL("./fixtures/statement-aes-256.pdf", import.meta.url)));

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
	const book = emptyPlaybook();
	book.alert_patterns.push({ id: "p", institution: "hsbc", from: "alerts@hsbc.com.sg", body: "ending (?<last4>\\d{4}) charged SGD (?<amount>[\\d.]+) at (?<merchant>.+?) on (?<date>\\d{4}-\\d{2}-\\d{2})", kind_hint: "purchase", default_currency: "SGD", date_format: "YYYY-MM-DD" });
	await publishPlaybook(db, book, null, "senior", "test", "2026-10-01T00:00:00.000Z");
});
afterEach(() => db.close());

function world() {
	const g = new FakeGmail();
	for (let i = 0; i < 60; i++) {
		const day = String(1 + (i % 28)).padStart(2, "0");
		g.add(mail({ id: `a${String(i).padStart(2, "0")}`, from: "alerts@hsbc.com.sg", text: `Card ending 2222 charged SGD ${(i + 1).toFixed(2)} at SHOP ${i} on 2026-09-${day}` }));
	}
	g.add(mail({ id: "st", from: "estatement@hsbc.com.sg", pdfs: [{ filename: "s.pdf", attachment_id: "x", size: 1 }] }));
	g.attachments.set("st/x", PDF);
	const lines = Array.from({ length: 80 }, (_, i) => ({ seq: i + 1, date: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, post_date: null, description: `STORE ${i}`, currency: "SGD", amount: "1.00", bill_currency: null, bill_amount: null, direction: "out", country: "SG", kind_hint: "purchase", card_last4: null }));
	const claude = new FakeClaude(() => ({ institution: "hsbc", statements: [{ last4: "1111", period_start: "2026-09-01", period_end: "2026-09-30", currency: "SGD", opening_balance: "0.00", opening_is_credit: false, closing_balance: "80.00", closing_is_credit: false, minimum_due: null, due_date: null, payments_credited: null, lines }], confidence: "sure", note: "" }));
	for (const id of g.messages.keys()) db.raw.prepare("INSERT INTO work (gmail_id, source, stage, attempts, created_at, updated_at) VALUES (?, 'daily', 'new', 0, 'x', 'x')").run(id);
	return { g, claude };
}

describe("the tick's budget, under real work", () => {
	it.each([400, 120])("at a setting of %i, no tick passes it and all the work finishes", async (setting) => {
		const { g, claude } = world();
		const c = exactCountingDb(db);
		const env = makeEnv(c.db, { ...MODELS, LEDGER_TICK_D1_BUDGET: String(setting), LEDGER_PDF_PW_HSBC: "made-up-pw-1234" });
		const deps = makeDeps();
		let ticks = 0;
		const left = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM work WHERE stage <> 'done'").get() as { n: number }).n;
		while (left() > 0 && ticks < 60) {
			c.reset();
			await runTick(env, deps, { gmail: g, claude }, [workQueue]);
			expect(c.queries()).toBeLessThanOrEqual(setting);
			deps.advance(60_000);
			ticks++;
		}
		expect(left()).toBe(0);
		expect(ticks).toBeGreaterThan(setting === 120 ? 3 : 1);
		expect(claude.calls).toHaveLength(1); // the statement was read once, however many ticks it took to import
		expect((db.raw.prepare("SELECT COUNT(*) AS n FROM evidence WHERE type = 'alert'").get() as { n: number }).n).toBe(60);
		expect((db.raw.prepare("SELECT COUNT(*) AS n FROM evidence WHERE type = 'statement_line'").get() as { n: number }).n).toBe(80);
		expect(db.raw.prepare("SELECT recon_status FROM statements").get()).toEqual({ recon_status: "reconciled" });
	});
});

describe("a tick Cloudflare stops part-way", () => {
	// A step that pays for one call, then never finishes: the close never runs.
	const payThenHang: Step = {
		name: "pay_then_hang",
		async run(t) {
			await readWith(t, "senior", "alert", "<email>hi</email>", AlertSchema, 1000);
			await new Promise(() => {});
		},
	};
	const ANSWER = { is_transaction: false, institution: "hsbc", last4: null, currency: "SGD", amount: "0.00", direction: "out", merchant: null, country: null, date: "2026-10-07", time: null, kind_hint: "purchase", confidence: "sure", note: "" };
	const settle = () => new Promise((r) => setTimeout(r, 50));

	it("the paid call is already in the spend log (the daily cap counts it)", async () => {
		void runTick(makeEnv(db, MODELS), makeDeps(), { claude: new FakeClaude(() => ANSWER) }, [payThenHang]);
		await settle();
		expect(db.raw.prepare("SELECT model, calls FROM api_spend").all()).toEqual([{ model: "claude-opus-5-5", calls: 1 }]);
	});

	it("in the backfill, the call already counts against the owner's approval", async () => {
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'backfill', 'x'), ('backfill_spent', '0.5', 'x')").run();
		void runTick(makeEnv(db, { ...MODELS, LEDGER_BACKFILL_APPROVED_USD: "20" }), makeDeps(), { claude: new FakeClaude(() => ANSWER) }, [payThenHang]);
		await settle();
		const usd = (db.raw.prepare("SELECT usd FROM api_spend").get() as { usd: number }).usd;
		expect(usd).toBeGreaterThan(0);
		const spent = Number((db.raw.prepare("SELECT value FROM sync_state WHERE key = 'backfill_spent'").get() as { value: string }).value);
		expect(spent).toBeCloseTo(0.5 + usd, 6);
	});
});
