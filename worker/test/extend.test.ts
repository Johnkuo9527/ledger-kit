/// The older months (extend.ts): a FINISHED backfill, then LEDGER_BACKFILL_MONTHS
/// raised → only the extra older months are read, by the senior model, from
/// their own approval, while the daily reading carries on. Made-up mail, a
/// made-up Claude, made-up exchange-rate feeds; no network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { emptyPlaybook } from "../../src/playbook";
import { publishPlaybook } from "../../src/playbook-store";
import { engineStatus } from "../src/alarms";
import { backfill } from "../src/backfill";
import { backfillExtra, olderMarker } from "../src/extend";
import { fxFeed } from "../src/fx-feed";
import { workQueue } from "../src/pipeline";
import { dailyPull } from "../src/pull";
import { EXTRA_SPEND_SUFFIX, runTick, type Services } from "../src/tick";
import { FakeClaude, MODELS, type Call } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { makeDeps, makeEnv } from "./helpers/harness";

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
/// What the made-up feeds were asked.
let asked: string[];

const BACKFILL = { months: ["2026-10", "2026-09", "2026-08"], i: 3, listing: null, started_at: "2026-10-01T02:00:00.000Z", done: true };

beforeEach(async () => {
	db = freshDb();
	D = makeDeps();
	asked = [];
	await addAccounts(db);
	const put = (key: string, value: unknown) => db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, 'x')").run(key, typeof value === "string" ? value : JSON.stringify(value));
	// A finished backfill of three months (Aug–Oct 2026), rates held from 2026-06-01 (its fxStart), TWD from the fallback feed.
	put("phase", "daily");
	put("backfill", BACKFILL);
	put("backfill_spent", "12.5");
	put("fx", { ecb_through: "2026-10-08", other_through: "2026-10-08", missing: ["TWD"], checked_at: "2026-10-09T01:59:00.000Z" });
	// The daily pull already ran today: only the queue reads daily mail here.
	put("daily_pull", { day: "2026-10-09", started_at: "2026-10-09T00:00:00.000Z", q: "x", page: null, done: true, listed: 0 });
	const pub = await publishPlaybook(db, { ...emptyPlaybook(), summary: "Three cards; mostly food.", categories: ["Food"], category_rules: [{ merchant_key: "KOPI", category: "Food" }], own_names: ["ALEX DOE"], judgement_notes: "Coffee is food.", escalate_when: ["an amount over SGD 5,000"] }, null, "senior", "the backfill's summary", "2026-10-02T00:00:00.000Z");
	expect(pub.ok).toBe(true);
	D.fetch = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		asked.push(url);
		const ecb = /frankfurter\.dev\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(url);
		if (ecb) return Response.json({ rates: { [ecb[1]!]: { USD: 0.75 }, "2026-05-29": { USD: 0.76 } } });
		const day = /currency-api@(\d{4}-\d{2}-\d{2})/.exec(url);
		if (day) return Response.json({ date: day[1], sgd: { twd: 24.5 } });
		throw new Error(`unexpected fetch ${url}`);
	}) as typeof fetch;
});
afterEach(() => db.close());

function mailbox(): FakeGmail {
	const g = new FakeGmail();
	const alert = (id: string, at: string, amount: string, merchant: string) => g.add(mail({ id, from: "HSBC <alerts@hsbc.com.sg>", received_at: at, text: `Card ending 1111 charged SGD ${amount} at ${merchant}` }));
	alert("aug-1", "2026-08-20T02:00:00.000Z", "30.00", "BOOKSHOP"); // read by the backfill already
	alert("jul-1", "2026-07-10T02:00:00.000Z", "8.00", "NOODLES");
	alert("jun-1", "2026-06-05T02:00:00.000Z", "50.00", "TAILOR");
	alert("may-1", "2026-05-05T02:00:00.000Z", "9.00", "TOOOLD"); // older than asked: never read
	return g;
}

const READINGS: Record<string, object> = {
	NOODLES: { amount: "8.00", merchant: "NOODLES", date: "2026-07-10" },
	TAILOR: { amount: "50.00", merchant: "TAILOR", date: "2026-06-05" },
	TODAY: { amount: "6.00", merchant: "TODAY", date: "2026-10-09" },
};

function claude(): FakeClaude {
	return new FakeClaude((c: Call) => {
		if (c.system.startsWith("You read ONE bank alert")) {
			const key = Object.keys(READINGS).find((k) => c.user.includes(` at ${k}`))!;
			return { is_transaction: true, institution: "hsbc", last4: "1111", currency: "SGD", direction: "out", country: "SG", time: null, kind_hint: "purchase", confidence: "sure", note: "", ...READINGS[key] };
		}
		if (c.system.includes("Write the playbook's summary"))
			return { summary: "A tailor in June.", categories: ["Clothes"], category_rules: [{ merchant_key: "TAILOR", category: "Clothes" }, { merchant_key: "KOPI", category: "Clothes" }], own_names: ["ALEX DOE", "J DOE"], judgement_notes: "", escalate_when: ["an amount over SGD 5,000"] };
		return new Error(`unexpected task: ${c.system.slice(0, 60)}`);
	});
}

const env = (over: Record<string, unknown> = {}) => makeEnv(db, { ...MODELS, LEDGER_BACKFILL_MONTHS: "3", LEDGER_CATEGORIES: "Food, Clothes, Others", LEDGER_FX_CURRENCIES: "USD,TWD", ...over });
const STEPS = [fxFeed, backfill, backfillExtra, dailyPull, workQueue];
const raw = (key: string) => (db.raw.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const state = (key: string) => {
	const v = raw(key);
	return v === undefined ? undefined : JSON.parse(v);
};
const openAlarms = () => db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL ORDER BY key").all();
const book = () => JSON.parse((db.raw.prepare("SELECT v.body_json FROM playbook_head h JOIN playbook_versions v ON v.version = h.version").get() as { body_json: string }).body_json);
const alertsRead = (c: FakeClaude) => c.calls.filter((x) => x.system.startsWith("You read ONE bank alert")).map((x) => [Object.keys(READINGS).find((k) => x.user.includes(` at ${k}`)), x.model]);
/// Daily mail: an alert today, queued by the daily pull.
function queueToday(g: FakeGmail) {
	g.add(mail({ id: "today-1", from: "HSBC <alerts@hsbc.com.sg>", received_at: "2026-10-09T01:00:00.000Z", text: "Card ending 1111 charged SGD 6.00 at TODAY" }));
	db.raw.prepare("INSERT INTO work (gmail_id, source, month, stage, attempts, created_at, updated_at) VALUES ('today-1', 'daily', NULL, 'new', 0, '2026-10-09T01:30:00.000Z', '2026-10-09T01:30:00.000Z')").run();
}

async function ticks(e: ReturnType<typeof env>, svc: Services, n: number, until?: () => boolean) {
	for (let i = 0; i < n && !until?.(); i++) {
		await runTick(e, D, svc, STEPS);
		D.advance(60_000);
	}
}

describe("reading older months after the backfill finished", () => {
	it("months raised 3 → 5: only Jul and Jun 2026 are read (newest first, Opus, own approval), rates first, the playbook only added to; the daily reading carries on with Sonnet", async () => {
		const g = mailbox();
		queueToday(g);
		const c = claude();
		const e = env({ LEDGER_BACKFILL_MONTHS: "5", LEDGER_BACKFILL_EXTRA_APPROVED_USD: "20" });
		await ticks(e, { gmail: g, claude: c }, 30, () => state("backfill_extra")?.done === true);
		const x = state("backfill_extra");
		expect(x).toMatchObject({ months: ["2026-07", "2026-06"], i: 2, reach_before: "2026-08", fx_from: "2026-04-01", done: true });
		// rates first: the older days asked of both feeds, and now held from 2026-04-01
		expect(asked.some((u) => u.includes("frankfurter.dev/v1/2026-04-01..2026-05-31"))).toBe(true);
		expect(asked.filter((u) => u.includes("cdn.jsdelivr.net")).length).toBe(61);
		expect(state("fx")).toMatchObject({ from: "2026-04-01", older: null, ecb_through: "2026-10-08" });
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM fx_rates WHERE currency = 'TWD' AND date < '2026-06-01'").get()).toEqual({ n: 61 });
		// only the new months, newest first, by the senior model; the daily alert by the daily model
		const order = alertsRead(c).map((r) => r[0]);
		expect(order.filter((k) => k !== "TODAY")).toEqual(["NOODLES", "TAILOR"]);
		expect(Object.fromEntries(alertsRead(c).map(([k, m]) => [k, m]))).toEqual({ NOODLES: "claude-opus-5-5", TAILOR: "claude-opus-5-5", TODAY: "claude-sonnet-5-5" });
		expect(c.calls.some((x) => x.user.includes("TOOOLD") || x.user.includes("BOOKSHOP"))).toBe(false);
		expect(db.raw.prepare("SELECT merchant_name FROM lines ORDER BY txn_date").all()).toEqual([{ merchant_name: "Tailor" }, { merchant_name: "Noodles" }, { merchant_name: "Today" }]);
		// the money: the older months' calls in their own pot, the backfill's untouched
		const extra = db.raw.prepare("SELECT SUM(usd) AS usd FROM api_spend WHERE model = ?").get(`claude-opus-5-5${EXTRA_SPEND_SUFFIX}`) as { usd: number };
		expect(extra.usd).toBeGreaterThan(0);
		expect(Number(raw("backfill_extra_spent"))).toBeCloseTo(extra.usd, 6);
		expect(raw("backfill_spent")).toBe("12.5");
		expect(db.raw.prepare("SELECT model FROM api_spend ORDER BY model").all()).toEqual([{ model: `claude-opus-5-5${EXTRA_SPEND_SUFFIX}` }, { model: "claude-sonnet-5-5" }]);
		// the playbook: everything kept, the older months added
		const b = book();
		expect(b.summary).toBe(`Three cards; mostly food.\n\n${olderMarker(x)} A tailor in June.`);
		expect(b.categories).toEqual(["Food", "Clothes", "Others"]); // the owner's own list holds (constrainToList)
		expect(b.category_rules).toEqual([{ merchant_key: "KOPI", category: "Food" }, { merchant_key: "TAILOR", category: "Clothes" }]);
		expect(b.own_names).toEqual(["ALEX DOE", "J DOE"]);
		expect(b.judgement_notes).toBe("Coffee is food.");
		expect(b.escalate_when).toEqual(["an amount over SGD 5,000"]);
		expect(raw("phase")).toBe("daily");
		expect((await engineStatus(db)).older_months).toMatchObject({ from: "2026-06", to: "2026-07", read: 2, total: 2, done: true });
		// done: nothing more, ever, while the months stay at 5
		const calls = c.calls.length;
		const versions = db.raw.prepare("SELECT COUNT(*) AS n FROM playbook_versions").get();
		await ticks(e, { gmail: g, claude: c }, 3);
		expect(c.calls.length).toBe(calls);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM playbook_versions").get()).toEqual(versions);
	});

	it("months unchanged (or lowered, or raised without the approval): nothing happens — no state, no call, no run row", async () => {
		const g = mailbox();
		const c = claude();
		for (const over of [{ LEDGER_BACKFILL_EXTRA_APPROVED_USD: "20" }, { LEDGER_BACKFILL_MONTHS: "2", LEDGER_BACKFILL_EXTRA_APPROVED_USD: "20" }, { LEDGER_BACKFILL_MONTHS: "5" }]) {
			await runTick(env(over), D, { gmail: g, claude: c }, [backfillExtra, workQueue]);
			D.advance(60_000);
		}
		expect(raw("backfill_extra")).toBeUndefined();
		expect(c.calls).toHaveLength(0);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM work").get()).toEqual({ n: 0 });
		expect((await engineStatus(db)).older_months).toBeNull();
	});

	it("an unfinished backfill is never extended", async () => {
		db.raw.prepare("UPDATE sync_state SET value = ? WHERE key = 'backfill'").run(JSON.stringify({ ...BACKFILL, i: 1, done: false }));
		db.raw.prepare("UPDATE sync_state SET value = 'backfill' WHERE key = 'phase'").run();
		await runTick(env({ LEDGER_BACKFILL_MONTHS: "5", LEDGER_BACKFILL_EXTRA_APPROVED_USD: "20" }), D, { gmail: mailbox(), claude: claude() }, [backfillExtra]);
		expect(raw("backfill_extra")).toBeUndefined();
	});

	it("its approval reached: it pauses with its own alarm while the daily reading carries on (even past US$3 of older-months spend today); raising the approval lets it finish", async () => {
		const g = mailbox();
		queueToday(g);
		const c = claude();
		// Already US$5 on the older months today: the daily cap (US$3) does not count it.
		db.raw.prepare("INSERT INTO api_spend (day, model, usd, calls) VALUES ('2026-10-09', ?, 5, 10)").run(`claude-opus-5-5${EXTRA_SPEND_SUFFIX}`);
		await ticks(env({ LEDGER_BACKFILL_MONTHS: "5", LEDGER_BACKFILL_EXTRA_APPROVED_USD: "0.001" }), { gmail: g, claude: c }, 6);
		expect(state("backfill_extra")).toMatchObject({ i: 0, done: false });
		expect(openAlarms()).toEqual([{ key: "backfill_extra_cap" }]);
		expect((db.raw.prepare("SELECT message FROM alarms WHERE key = 'backfill_extra_cap'").get() as { message: string }).message).toContain("LEDGER_BACKFILL_EXTRA_APPROVED_USD");
		expect(alertsRead(c)).toEqual([["TODAY", "claude-sonnet-5-5"]]);
		expect(c.calls.filter((x) => x.model === "claude-opus-5-5")).toHaveLength(0);
		expect(db.raw.prepare("SELECT stage FROM work WHERE gmail_id = 'jul-1'").get()).toEqual({ stage: "new" });
		expect(raw("backfill_extra_spent") ?? "0").toBe("0");
		expect((await engineStatus(db)).older_months).toMatchObject({ read: 0, total: 2, spent_usd: 0, done: false });
		// raised: it finishes, the alarm clears
		for (let i = 0; i < 40 && state("backfill_extra")?.done !== true; i++) {
			D.advance(31 * 60_000);
			await runTick(env({ LEDGER_BACKFILL_MONTHS: "5", LEDGER_BACKFILL_EXTRA_APPROVED_USD: "20" }), D, { gmail: g, claude: c }, STEPS);
		}
		expect(state("backfill_extra").done).toBe(true);
		expect(openAlarms()).toEqual([]);
		expect(new Set(alertsRead(c).map((r) => r[0]))).toEqual(new Set(["TODAY", "NOODLES", "TAILOR"]));
	});

	it("waits for the older rates before listing a single month", async () => {
		D.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
		const c = claude();
		const g = mailbox();
		const r = await runTick(env({ LEDGER_BACKFILL_MONTHS: "5", LEDGER_BACKFILL_EXTRA_APPROVED_USD: "20" }), D, { gmail: g, claude: c }, STEPS);
		expect(r.counts.backfill_extra_waiting_for_rates).toBe(1);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM work").get()).toEqual({ n: 0 });
		expect(c.calls).toHaveLength(0);
	});

	it("raised again after an extension finished: the next months on from where it stopped, and the approval is a total (not reset)", async () => {
		const g = mailbox();
		const c = claude();
		await ticks(env({ LEDGER_BACKFILL_MONTHS: "4", LEDGER_BACKFILL_EXTRA_APPROVED_USD: "20" }), { gmail: g, claude: c }, 30, () => state("backfill_extra")?.done === true);
		expect(state("backfill_extra")).toMatchObject({ months: ["2026-07"], done: true });
		const spent = Number(raw("backfill_extra_spent"));
		expect(spent).toBeGreaterThan(0);
		await ticks(env({ LEDGER_BACKFILL_MONTHS: "5", LEDGER_BACKFILL_EXTRA_APPROVED_USD: "20" }), { gmail: g, claude: c }, 30, () => state("backfill_extra")?.months?.[0] === "2026-06" && state("backfill_extra").done === true);
		expect(state("backfill_extra")).toMatchObject({ months: ["2026-06"], reach_before: "2026-07", done: true });
		expect(Number(raw("backfill_extra_spent"))).toBeGreaterThan(spent);
		expect(alertsRead(c).map((r) => r[0])).toEqual(["NOODLES", "TAILOR"]);
		expect(book().summary).toContain("Older months 2026-07 to 2026-07:");
		expect(book().summary).toContain("Older months 2026-06 to 2026-06:");
	});
});
