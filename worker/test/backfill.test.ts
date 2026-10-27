/// Dry run → the owner's approval → backfill → daily.
/// Three made-up months of mail, a made-up Claude, rates already filled.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { SUMMARY_MARKER } from "../../src/dedup";
import { engineStatus } from "../src/alarms";
import { backfill } from "../src/backfill";
import { dryRun, estimate, monthsBack, monthWindow, type MonthCount } from "../src/dryrun";
import { workQueue } from "../src/pipeline";
import { runTick, type Services } from "../src/tick";
import { FakeClaude, MODELS, type Call } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { makeDeps, makeEnv } from "./helpers/harness";

const PDF = new Uint8Array(readFileSync(new URL("./fixtures/statement-aes-256.pdf", import.meta.url)));
const PW = "made-up-pw-1234";

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
beforeEach(async () => {
	db = freshDb();
	D = makeDeps();
	await addAccounts(db);
	db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('fx', ?, 'x')").run(JSON.stringify({ ecb_through: "2026-10-08", other_through: "2026-10-08", missing: [], checked_at: null }));
});
afterEach(() => db.close());

function mailbox(): FakeGmail {
	const g = new FakeGmail();
	const alert = (id: string, at: string, amount: string, merchant: string) => g.add(mail({ id, from: "HSBC <alerts@hsbc.com.sg>", received_at: at, text: `Card ending 1111 charged SGD ${amount} at ${merchant}` }));
	alert("oct-1", "2026-10-03T02:00:00.000Z", "4.50", "KOPI");
	alert("sep-1", "2026-09-20T02:00:00.000Z", "12.00", "BAKERY");
	alert("aug-1", "2026-08-20T02:00:00.000Z", "30.00", "BOOKSHOP");
	g.add(mail({ id: "sep-st", from: "HSBC <estatement@hsbc.com.sg>", received_at: "2026-09-17T02:00:00.000Z", pdfs: [{ filename: "s.pdf", attachment_id: "x", size: 1 }] }));
	g.attachments.set("sep-st/x", PDF);
	g.add(mail({ id: "news", from: "Shop <news@shop.example>", received_at: "2026-09-01T02:00:00.000Z", subject: "Your receipt", text: "Order total SGD 20.00" }));
	return g;
}

const READINGS: Record<string, object> = {
	KOPI: { amount: "4.50", merchant: "KOPI", date: "2026-10-03" },
	BAKERY: { amount: "12.00", merchant: "BAKERY", date: "2026-09-20" },
	BOOKSHOP: { amount: "30.00", merchant: "BOOKSHOP", date: "2026-08-20" },
};

function claude(): FakeClaude {
	return new FakeClaude((c: Call) => {
		if (c.system.startsWith("You read ONE bank alert")) {
			const key = Object.keys(READINGS).find((k) => c.user.includes(` at ${k}`))!;
			return { is_transaction: true, institution: "hsbc", last4: "1111", currency: "SGD", direction: "out", country: "SG", time: null, kind_hint: "purchase", confidence: "sure", note: "", ...READINGS[key] };
		}
		if (c.system.startsWith("You read ONE email that may be a receipt")) return { is_receipt: false, merchant: "Shop", currency: "SGD", amount: "20.00", direction: "out", date: "2026-09-01", order_id: null, items: [], flights: [], hotels: [], confidence: "sure", note: "" };
		if (c.system.startsWith("You read the text of ONE card or bank statement"))
			return {
				institution: "hsbc",
				statements: [{ last4: "1111", period_start: "2026-08-16", period_end: "2026-09-15", currency: "SGD", opening_balance: "0.00", opening_is_credit: false, closing_balance: "30.00", closing_is_credit: false, minimum_due: null, due_date: null, payments_credited: null, lines: [{ seq: 1, date: "2026-08-20", post_date: null, description: "BOOKSHOP", currency: "SGD", amount: "30.00", bill_currency: null, bill_amount: null, direction: "out", country: "SG", kind_hint: "purchase", card_last4: null }] }],
				confidence: "sure",
				note: "",
			};
		if (c.system.includes("Write the playbook's summary")) return { summary: "Three cards; mostly food.", categories: ["Food", "Books"], category_rules: [{ merchant_key: "BOOKSHOP", category: "Books" }, { merchant_key: "X", category: "Nope" }], own_names: ["ALEX DOE"], judgement_notes: "Coffee is food.", escalate_when: ["an amount over SGD 5,000"] };
		return new Error(`unexpected task: ${c.system.slice(0, 60)}`);
	});
}

const env = (over: Record<string, unknown> = {}) => makeEnv(db, { ...MODELS, LEDGER_BACKFILL_MONTHS: "3", LEDGER_PDF_PW_HSBC: PW, ...over });
const STEPS = [dryRun, backfill, workQueue];
const phase = () => (db.raw.prepare("SELECT value FROM sync_state WHERE key = 'phase'").get() as { value: string } | undefined)?.value;
const state = (key: string) => JSON.parse((db.raw.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string }).value);

describe("the dry run", () => {
	it("counts three months without a single model call, checks the PDF password, and emails the estimate once", async () => {
		const g = mailbox();
		const c = claude();
		const svc: Services = { gmail: g, claude: c };
		await runTick(env(), D, svc, STEPS);
		expect(c.calls).toHaveLength(0);
		expect(phase()).toBe("awaiting_approval");
		const dr = state("dry_run");
		expect(dr.months.map((m: MonthCount) => [m.month, m.alerts, m.statements, m.receipts])).toEqual([
			["2026-10", 1, 0, 0],
			["2026-09", 1, 1, 1],
			["2026-08", 1, 0, 0],
		]);
		expect(dr.passwords).toEqual({ HSBC: "ok" });
		expect(D.mail.sent).toHaveLength(1);
		const m = D.mail.sent[0]!;
		expect(m.subject).toMatch(/^Your ledger: two years of email counted — about US\$\d+\.\d\d to read, needs your OK$/);
		expect(m.text).toContain("Opus 5.5");
		expect(m.text).toContain("Sonnet 5.5");
		expect(m.text).toContain("LEDGER_BACKFILL_APPROVED_USD");
		expect(m.text).toContain(SUMMARY_MARKER);
		expect((m as unknown as { headers: Record<string, string> }).headers).toEqual({ "X-Ledger-Summary": "1" });
		expect((await engineStatus(db)).estimate?.backfill).toHaveLength(2);
		// not approved: nothing happens, and the email is not sent again
		D.advance(60_000);
		await runTick(env(), D, svc, STEPS);
		expect(phase()).toBe("awaiting_approval");
		expect(D.mail.sent).toHaveLength(1);
		expect(c.calls).toHaveLength(0);
	});

	it("a missing password is named in the email before the owner approves", async () => {
		await runTick(env({ LEDGER_PDF_PW_HSBC: undefined }), D, { gmail: mailbox() }, STEPS);
		expect(state("dry_run").passwords).toEqual({ HSBC: "missing" });
		expect(D.mail.sent[0]!.text).toContain("npx wrangler secret put LEDGER_PDF_PW_HSBC");
	});

	it("the estimate: both models, ±30%, Opus dearer than Sonnet, and the monthly cost after", () => {
		const month = (m: string): MonthCount => ({ month: m, alerts: 40, receipts: 10, statements: 4, ignored: 0, pdfs: 4, pages: 12, alert_chars: 40 * 600, receipt_chars: 10 * 3000, pdf_chars: 4 * 12000, alert_senders: { "a@dbs.com": 25, "b@hsbc.com.sg": 15 } });
		const e = estimate(monthsBack("2026-10-09", 24).map(month), "claude-sonnet-5-5");
		const [opus, sonnet] = e.backfill;
		expect(opus!.model).toBe("claude-opus-5-5");
		expect(sonnet!.model).toBe("claude-sonnet-5-5");
		expect(opus!.usd).toBeGreaterThan(sonnet!.usd);
		expect(opus!.low).toBeCloseTo(opus!.usd * 0.7, 1);
		expect(opus!.high).toBeCloseTo(opus!.usd * 1.3, 1);
		expect(e.monthly_daily.usd).toBeGreaterThan(0);
		expect(e.monthly_daily.usd).toBeLessThan(sonnet!.usd);
		expect(e.totals).toEqual({ alerts: 960, receipts: 240, statements: 96, pdfs: 96, pages: 288 });
	});

	it("months are Singapore months", () => {
		expect(monthsBack("2026-01-15", 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
		expect(monthWindow("2026-09").after.toISOString()).toBe("2026-08-31T16:00:00.000Z");
	});
});

describe("the backfill", () => {
	it("approved: reads newest month first with the senior model, parks the statement until its month, writes the playbook, then hands over to the daily reading", async () => {
		const g = mailbox();
		const c = claude();
		const svc: Services = { gmail: g, claude: c };
		await runTick(env(), D, svc, STEPS); // dry run
		let ticks = 0;
		while (phase() !== "daily" && ticks < 30) {
			D.advance(60_000);
			await runTick(env({ LEDGER_BACKFILL_APPROVED_USD: "20" }), D, svc, STEPS);
			ticks++;
		}
		expect(phase()).toBe("daily");
		expect(new Set(c.calls.filter((x) => !x.system.includes("summary")).map((x) => x.model))).toEqual(new Set(["claude-opus-5-5"]));
		// newest month first
		const alertOrder = c.calls.filter((x) => x.system.startsWith("You read ONE bank alert")).map((x) => Object.keys(READINGS).find((k) => x.user.includes(` at ${k}`)));
		expect(alertOrder).toEqual(["KOPI", "BAKERY", "BOOKSHOP"]);
		// the August alert was in before the statement (Aug 16 → Sep 15) was imported: it attached, no duplicate line
		expect(db.raw.prepare("SELECT merchant_name, COUNT(*) AS n FROM lines GROUP BY merchant_name ORDER BY merchant_name").all()).toEqual([
			{ merchant_name: "Bakery", n: 1 },
			{ merchant_name: "Bookshop", n: 1 },
			{ merchant_name: "Kopi", n: 1 },
		]);
		expect(db.raw.prepare("SELECT recon_status FROM statements").get()).toEqual({ recon_status: "reconciled" });
		const book = JSON.parse((db.raw.prepare("SELECT v.body_json FROM playbook_head h JOIN playbook_versions v ON v.version = h.version").get() as { body_json: string }).body_json);
		expect(book).toMatchObject({ summary: "Three cards; mostly food.", categories: ["Food", "Books"], own_names: ["ALEX DOE"], category_rules: [{ merchant_key: "BOOKSHOP", category: "Books" }] });
		const b = state("backfill");
		const spent = (db.raw.prepare("SELECT SUM(usd) AS usd FROM api_spend").get() as { usd: number }).usd;
		expect(b.done).toBe(true);
		expect(Number(state("backfill_spent"))).toBeCloseTo(spent, 6);
	});

	it("reaching the approved amount pauses it with an alarm; raising the approval lets it finish", async () => {
		const g = mailbox();
		const c = claude();
		await runTick(env(), D, { gmail: g, claude: c }, STEPS);
		for (let i = 0; i < 5; i++) {
			D.advance(60_000);
			await runTick(env({ LEDGER_BACKFILL_APPROVED_USD: "0.02" }), D, { gmail: g, claude: c }, STEPS);
		}
		expect(phase()).toBe("backfill");
		expect(db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL").all()).toEqual([{ key: "backfill_cap" }]);
		for (let i = 0; i < 40 && phase() !== "daily"; i++) {
			D.advance(31 * 60_000);
			await runTick(env({ LEDGER_BACKFILL_APPROVED_USD: "20" }), D, { gmail: g, claude: c }, STEPS);
		}
		expect(phase()).toBe("daily");
		expect(db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL").all()).toEqual([]);
	});

	it("waits for two years of exchange rates first", async () => {
		db.raw.prepare("DELETE FROM sync_state WHERE key = 'fx'").run();
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'awaiting_approval', 'x')").run();
		const c = claude();
		const r = await runTick(env({ LEDGER_BACKFILL_APPROVED_USD: "20" }), D, { gmail: mailbox(), claude: c }, STEPS);
		expect(phase()).toBe("backfill");
		expect(r.counts.backfill_waiting_for_rates).toBe(1);
		expect(c.calls).toHaveLength(0);
	});
});
