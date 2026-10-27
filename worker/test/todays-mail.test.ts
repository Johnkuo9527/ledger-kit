/// Today's mail first (13 Oct 2026): Gmail checked every 15 minutes,
/// new bank alerts read before any heavy work, uploads and bills read again
/// paid from their own approval, a mail reserve in the daily cap, an alarm
/// when bank mail waits, and the read-only diagnostic on /api/status.
/// Made-up mail, a made-up Claude, made-up PDFs.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { emptyPlaybook, type AlertPattern } from "../../src/playbook";
import { publishPlaybook } from "../../src/playbook-store";
import { handleRequest } from "../src/app";
import { backfillPassed, mailWatch, STUCK_AFTER_MS, todaysMail, workQueue } from "../src/pipeline";
import { CHECK_EVERY_MS, CHECK_OVERLAP_MS, mailCheck, OVERLAP_MS } from "../src/pull";
import { ENGINE_STEPS } from "../src/steps";
import { runTick, type Services, type Tick } from "../src/tick";
import { takeUploads } from "../src/uploads";
import { FakeClaude, MODELS, type Call } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { CTX, exactCountingDb, get, json, makeDeps, makeEnv, signedIn, TEST_ASSETS } from "./helpers/harness";

// 14:30 in Singapore on 13 Oct 2026, as when it was first checked.
const START = "2026-10-13T06:30:00.000Z";
const PLAIN = new Uint8Array(readFileSync(new URL("./fixtures/statement-plain.pdf", import.meta.url)));
const LOCKED = new Uint8Array(readFileSync(new URL("./fixtures/statement-aes-256.pdf", import.meta.url)));
const PW = "made-up-pw-1234";
const isStatement = (c: Call) => c.system.includes("ONE card or bank statement PDF");

const ALERT_TEXT = "Your card ending 1111 was charged SGD 12.50 at KOPI CORNER on 13 Oct 2026.";
const alertMail = (id: string, received_at: string, text = ALERT_TEXT) => mail({ id, from: "HSBC <alerts@hsbc.com.sg>", subject: "Card alert", text, received_at });
const ALERT = { is_transaction: true, institution: "hsbc", last4: "1111", currency: "SGD", amount: "12.50", direction: "out", merchant: "KOPI CORNER", country: "SG", date: "2026-10-13", time: null, kind_hint: "purchase", confidence: "sure", note: "" };
const PATTERN: AlertPattern = { id: "hsbc-1", institution: "hsbc", from: "alerts@hsbc.com.sg", body: "ending (?<last4>\\d{4}) was charged (?<currency>[A-Z]{3}) (?<amount>[\\d,.]+) at (?<merchant>.+?) on (?<date>\\d{2} \\w{3} \\d{4})", kind_hint: "purchase", default_currency: "SGD", date_format: "D MMM YYYY" };
const CITI = {
	institution: "citi",
	statements: [
		{
			last4: "3333",
			period_start: "2026-09-16",
			period_end: "2026-10-15",
			currency: "SGD",
			opening_balance: "0.00",
			opening_is_credit: false,
			closing_balance: "12.00",
			closing_is_credit: false,
			minimum_due: "50.00",
			due_date: "2026-11-05",
			payments_credited: "0.00",
			lines: [{ seq: 1, date: "2026-09-20", post_date: null, description: "BAKERY", currency: "SGD", amount: "12.00", bill_currency: null, bill_amount: null, direction: "out", country: "SG", kind_hint: "purchase", card_last4: null }],
		},
	],
	confidence: "sure",
	note: "",
};

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
beforeEach(async () => {
	db = freshDb();
	D = makeDeps(START);
	D.fetch = (async () => new Response("no", { status: 503 })) as typeof fetch; // no FX feed in these tests
	await addAccounts(db);
	// The backfill is done; today's daily pull already ran this morning (06:00).
	db.raw
		.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'daily', 'x'), ('backfill', ?, 'x'), ('daily_pull', ?, 'x')")
		.run(JSON.stringify({ done: true, started_at: "2026-10-01T00:00:00.000Z", months: ["2026-10", "2026-09"], i: 2 }), JSON.stringify({ day: "2026-10-13", started_at: "2026-10-12T22:00:00.000Z", q: "x", page: null, done: true, listed: 0 }));
});
afterEach(() => db.close());

const rows = (sql: string) => db.raw.prepare(sql).all() as Record<string, unknown>[];
const openAlarms = () => rows("SELECT key, message FROM alarms WHERE cleared_at IS NULL ORDER BY key") as { key: string; message: string }[];
const spendToday = (usd: number, model = "claude-sonnet-5-5") => db.raw.prepare("INSERT INTO api_spend (day, model, usd, calls) VALUES ('2026-10-13', ?, ?, 1)").run(model, usd);
async function withPattern() {
	const book = emptyPlaybook();
	book.alert_patterns.push(PATTERN);
	await publishPlaybook(db, book, null, "senior", "test", "2026-10-01T00:00:00.000Z");
}
/// `n` different uploads (one file each) waiting to be read: "heavy" catching up.
async function uploads(n: number) {
	const files = Array.from({ length: n }, (_, i) => {
		const bytes = new Uint8Array([...PLAIN, ...new TextEncoder().encode(`\n% copy ${i}\n`)]);
		return { filename: `Citi ${i}.pdf`, bytes, size: bytes.length };
	});
	await takeUploads(db, new Date(new Date(START).getTime() - 3_600_000), files, { via: "page", account_id: "card-c" });
}
const engine = (svc: Services, env: Record<string, string> = {}) => runTick(makeEnv(db, { ...MODELS, ...env }), D, svc, ENGINE_STEPS);

describe("the mail check", () => {
	it("looks for new mail every 15 minutes, reaching back an hour before the last check started", async () => {
		const g = new FakeGmail().add(alertMail("m1", "2026-10-13T06:20:00.000Z"));
		const env = makeEnv(db);
		await runTick(env, D, { gmail: g }, [mailCheck]);
		expect(g.calls.list).toBe(1);
		// The first check reaches back as far as the daily pull would: two days before it started.
		expect(g.queries[0]).toContain(`after:${Math.floor((new Date("2026-10-12T22:00:00.000Z").getTime() - OVERLAP_MS) / 1000)}`);
		expect(rows("SELECT gmail_id, source, stage FROM work")).toEqual([{ gmail_id: "m1", source: "daily", stage: "new" }]);

		// One tick a minute for an hour: four more checks, one every 15 minutes.
		for (let i = 0; i < 60; i++) {
			D.advance(60_000);
			if (i === 20) g.add(alertMail("m2", D.now().toISOString()));
			await runTick(env, D, { gmail: g }, [mailCheck]);
		}
		expect(g.calls.list).toBe(5);
		expect(rows("SELECT gmail_id FROM work ORDER BY gmail_id")).toEqual([{ gmail_id: "m1" }, { gmail_id: "m2" }]);
		// The latest check reached back to an hour before the one before it started.
		const after = Number(/after:(\d+)/.exec(g.queries.at(-1)!)![1]) * 1000;
		expect(after).toBe(new Date(START).getTime() + 3 * CHECK_EVERY_MS - CHECK_OVERLAP_MS);
		const state = JSON.parse((db.raw.prepare("SELECT value FROM sync_state WHERE key = 'mail_check'").get() as { value: string }).value);
		expect(state).toMatchObject({ done: true, ok_at: D.now().toISOString() });
	});

	it("is cheap when nothing is new: one Gmail call and one write", async () => {
		const g = new FakeGmail();
		const c = exactCountingDb(db);
		const env = makeEnv(c.db);
		await runTick(env, D, { gmail: g }, [mailCheck]);
		D.advance(CHECK_EVERY_MS);
		c.reset();
		await runTick(env, D, { gmail: g }, [mailCheck]);
		expect(g.calls.list).toBe(2);
		// the lock, the state read, the alarms read, the playbook's senders, the check's own write, the close
		expect(c.queries()).toBeLessThanOrEqual(6);
		expect(rows("SELECT COUNT(*) AS n FROM runs")).toEqual([{ n: 0 }]); // no run-log line for an empty check
	});

	it("waits for the backfill to list this month, and carries on when Gmail answers again", async () => {
		const g = new FakeGmail().add(alertMail("m1", "2026-10-13T06:20:00.000Z"));
		db.raw.prepare("UPDATE sync_state SET value = 'backfill' WHERE key = 'phase'").run();
		db.raw.prepare("UPDATE sync_state SET value = ? WHERE key = 'backfill'").run(JSON.stringify({ months: ["2026-10", "2026-09"], i: 0, listing: { q: "x", page: "p2", done: false, listed: 100 }, started_at: "2026-10-01T00:00:00.000Z", done: false }));
		await runTick(makeEnv(db), D, { gmail: g }, [mailCheck]);
		expect(g.calls.list).toBe(0);
		db.raw.prepare("UPDATE sync_state SET value = 'daily' WHERE key = 'phase'").run();
		const { GmailError } = await import("../src/gmail");
		g.fail = new GmailError("unavailable", "Google is down");
		await runTick(makeEnv(db), D, { gmail: g }, [mailCheck]);
		expect(rows("SELECT gmail_id FROM work")).toEqual([]);
		g.fail = null;
		D.advance(60_000); // the next minute, not 15 later: the unfinished check carries on
		await runTick(makeEnv(db), D, { gmail: g }, [mailCheck]);
		expect(rows("SELECT gmail_id FROM work")).toEqual([{ gmail_id: "m1" }]);
	});
});

describe("today's mail first", () => {
	it("a heavy upload queue and a spent daily cap: a patterned alert still becomes a line within one tick, before any upload is read", async () => {
		await withPattern();
		await uploads(22);
		spendToday(3); // the whole US$3 of today already spent
		const g = new FakeGmail().add(alertMail("a1", "2026-10-13T06:29:00.000Z"));
		let linesAtFirstCall: number | null = null;
		const claude = new FakeClaude((c: Call) => {
			linesAtFirstCall ??= (db.raw.prepare("SELECT COUNT(*) AS n FROM lines").get() as { n: number }).n;
			return isStatement(c) ? CITI : new Error("no model for a patterned alert");
		});
		const r = await engine({ gmail: g, claude }, { LEDGER_CATCHUP_APPROVED_USD: "10" });
		expect(r.errors).toEqual([]);
		expect(rows("SELECT account_id, merchant_raw, bill_minor, txn_date FROM lines WHERE merchant_raw = 'KOPI CORNER'")).toEqual([{ account_id: "card-a", merchant_raw: "KOPI CORNER", bill_minor: 1250, txn_date: "2026-10-13" }]);
		expect(rows("SELECT stage, kind FROM work WHERE gmail_id = 'a1'")).toEqual([{ stage: "done", kind: "alert" }]);
		// The uploads were read in the same tick, after it, from their own approval.
		expect(claude.calls.length).toBeGreaterThan(0);
		expect(linesAtFirstCall).toBe(1);
		expect(claude.calls.every((c) => isStatement(c))).toBe(true);
		expect(rows("SELECT model FROM api_spend WHERE day = '2026-10-13' ORDER BY model")).toEqual([{ model: "claude-sonnet-5-5" }, { model: "claude-sonnet-5-5 (catch-up)" }]);
		expect(rows("SELECT usd FROM api_spend WHERE model = 'claude-sonnet-5-5'")).toEqual([{ usd: 3 }]); // the daily cap untouched
	});

	it("no pattern: the alert may use the mail reserve, which statements and other work may not", async () => {
		spendToday(2.5); // US$0.50 left of US$3; US$1 is kept for bank alerts
		const g = new FakeGmail().add(alertMail("a1", "2026-10-13T06:29:00.000Z"));
		// An emailed statement (the daily pot) waiting too.
		g.add(mail({ id: "st1", from: "DBS <statements@dbs.com>", subject: "Your statement", received_at: "2026-10-13T06:28:00.000Z", pdfs: [{ filename: "s.pdf", attachment_id: "p1", size: 10 }] }));
		g.attachments.set("st1/p1", LOCKED);
		const claude = new FakeClaude((c: Call) => (isStatement(c) ? new Error("the reserve must hold") : ALERT));
		const r = await runTick(makeEnv(db, { ...MODELS, LEDGER_PDF_PW_DBS: PW }), D, { gmail: g, claude }, [mailCheck, todaysMail, workQueue]);
		expect(r.errors).toEqual([]);
		expect(claude.calls).toHaveLength(1); // the alert only
		expect(rows("SELECT merchant_raw FROM lines")).toEqual([{ merchant_raw: "KOPI CORNER" }]);
		expect(rows("SELECT stage, kind FROM work WHERE gmail_id = 'st1'")).toEqual([{ stage: "new", kind: "statement" }]); // waits for tomorrow's allowance
		expect(openAlarms()).toEqual([]);
	});

	it("a statement in today's mail is only sorted first; the work queue reads it", async () => {
		const g = new FakeGmail().add(mail({ id: "st1", from: "DBS <statements@dbs.com>", subject: "Your statement", received_at: "2026-10-13T06:28:00.000Z", pdfs: [{ filename: "s.pdf", attachment_id: "p1", size: 10 }] }));
		const claude = new FakeClaude(() => new Error("not now"));
		await runTick(makeEnv(db, { ...MODELS }), D, { gmail: g, claude }, [mailCheck, todaysMail]);
		expect(claude.calls).toHaveLength(0);
		expect(g.calls.attachment).toBe(0);
		expect(rows("SELECT stage, kind FROM work")).toEqual([{ stage: "new", kind: "statement" }]);
	});
});

describe("catching up has its own approval", () => {
	it("an upload is never paid from the daily cap: unapproved, it waits and the page says why; approved, it is read", async () => {
		await uploads(1);
		const claude = new FakeClaude(() => CITI);
		await runTick(makeEnv(db, { ...MODELS }), D, { claude }, [workQueue]);
		expect(claude.calls).toHaveLength(0);
		expect(openAlarms().map((a) => a.key)).toEqual(["catchup_cap"]);
		expect(openAlarms()[0]!.message).toContain("LEDGER_CATCHUP_APPROVED_USD");
		expect(rows("SELECT stage FROM work")).toEqual([{ stage: "new" }]);
		D.advance(31 * 60_000);
		await runTick(makeEnv(db, { ...MODELS, LEDGER_CATCHUP_APPROVED_USD: "5" }), D, { claude }, [workQueue]);
		expect(claude.calls).toHaveLength(1);
		expect(rows("SELECT stage FROM work")).toEqual([{ stage: "done" }]);
		expect(openAlarms()).toEqual([]);
		const spent = Number((db.raw.prepare("SELECT value FROM sync_state WHERE key = 'catchup_spent'").get() as { value: string }).value);
		expect(spent).toBeGreaterThan(0);
		expect(rows("SELECT model FROM api_spend")).toEqual([{ model: "claude-sonnet-5-5 (catch-up)" }]);
	});

	it("its alarm goes once nothing of it waits", async () => {
		await uploads(1);
		await runTick(makeEnv(db, { ...MODELS }), D, { claude: new FakeClaude(() => CITI) }, [workQueue]);
		expect(openAlarms().map((a) => a.key)).toEqual(["catchup_cap"]);
		await runTick(makeEnv(db), D, {}, [mailWatch]);
		expect(openAlarms().map((a) => a.key)).toEqual(["catchup_cap"]); // still waiting
		db.raw.prepare("UPDATE work SET stage = 'failed'").run(); // e.g. its 14 days ran out
		D.advance(15 * 60_000);
		await runTick(makeEnv(db), D, {}, [mailWatch]);
		expect(openAlarms()).toEqual([]);
	});

	it("a bill the look back reads again is catching up too", async () => {
		db.raw.prepare("INSERT INTO work (gmail_id, source, kind, stage, attempts, payload_json, created_at, updated_at) VALUES ('old1', 'backfill', 'statement', 'new', 0, '{\"reread\":true}', 'x', 'x')").run();
		const g = new FakeGmail().add(mail({ id: "old1", from: "Taishin <card@taishinbank.com.tw>", subject: "帳單", pdfs: [{ filename: "s.pdf", attachment_id: "p1", size: 10 }] }));
		g.attachments.set("old1/p1", LOCKED);
		const claude = new FakeClaude(() => new Error("must not be asked"));
		await runTick(makeEnv(db, { ...MODELS, LEDGER_PDF_PW_TAISHIN: PW }), D, { gmail: g, claude }, [workQueue]);
		expect(claude.calls).toHaveLength(0);
		expect(openAlarms().map((a) => a.key)).toEqual(["catchup_cap"]);
		await runTick(makeEnv(db), D, {}, [mailWatch]);
		expect(openAlarms().map((a) => a.key)).toEqual(["catchup_cap"]); // the bill still waits for it
	});
});

describe("the watch: bank mail never waits quietly", () => {
	it("an alert stuck for over two hours raises an alarm with the reason; it clears once read", async () => {
		const found = new Date(new Date(START).getTime() - STUCK_AFTER_MS - 60_000).toISOString();
		db.raw.prepare("INSERT INTO work (gmail_id, source, kind, stage, attempts, not_before, created_at, updated_at) VALUES ('a1', 'daily', 'alert', 'new', 0, ?, ?, 'x')").run(new Date(new Date(START).getTime() + 1_800_000).toISOString(), found);
		spendToday(3);
		await runTick(makeEnv(db, { ...MODELS }), D, { gmail: new FakeGmail(), claude: new FakeClaude(() => ALERT) }, [mailWatch]);
		const [alarm] = openAlarms();
		expect(alarm?.key).toBe("mail_stuck");
		expect(alarm?.message).toContain("1 bank email has waited more than 2 hours");
		expect(alarm?.message).toContain("12:29 on 2026-10-13 (Asia/Singapore time)");
		expect(alarm?.message).toContain("allowance for the AI reader is used up");
		// The page shows it.
		const status = await json(await handleRequest(get("/api/status", await signedIn(D.now())), makeEnv(db), CTX, { assets: TEST_ASSETS, deps: D }));
		expect((status.alarms as { key: string }[]).map((a) => a.key)).toEqual(["mail_stuck"]);
		// Read at last: the next look clears it.
		db.raw.prepare("UPDATE work SET stage = 'done'").run();
		D.advance(15 * 60_000);
		await runTick(makeEnv(db, { ...MODELS }), D, { gmail: new FakeGmail() }, [mailWatch]);
		expect(openAlarms()).toEqual([]);
	});

	it("a pile of alerts from a sender with no pattern, and no model to read them: the alarm, not silence", async () => {
		const g = new FakeGmail();
		for (let i = 0; i < 3; i++) g.add(mail({ id: `x${i}`, from: "DBS <paynow@dbs.com>", subject: "PayNow", text: `You sent SGD ${i + 1}.00`, received_at: "2026-10-13T06:20:00.000Z" }));
		const env = makeEnv(db, { ...MODELS });
		await runTick(env, D, { gmail: g }, ENGINE_STEPS); // no Claude at all
		expect(rows("SELECT COUNT(*) AS n FROM work WHERE stage = 'new' AND kind = 'alert'")).toEqual([{ n: 3 }]);
		D.advance(STUCK_AFTER_MS + 15 * 60_000);
		await runTick(env, D, { gmail: g }, ENGINE_STEPS);
		expect(openAlarms().find((a) => a.key === "mail_stuck")?.message).toContain("3 bank emails have waited");
	});

	it("Gmail not checked for over two hours raises its own alarm", async () => {
		const ok = new Date(new Date(START).getTime() - STUCK_AFTER_MS - 60_000).toISOString();
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('mail_check', ?, 'x')").run(JSON.stringify({ started_at: ok, ok_at: ok, q: "x", page: null, done: true, listed: 0 }));
		await runTick(makeEnv(db), D, {}, [mailWatch]);
		expect(openAlarms().map((a) => a.key)).toEqual(["mail_check_late"]);
	});
});

describe("GET /api/status: the diagnostic", () => {
	it("says when Gmail was last checked, what work waits by stage and kind, and today's spend against each cap", async () => {
		await uploads(2);
		spendToday(1.25);
		spendToday(0.5, "claude-opus-5-5 (catch-up)");
		spendToday(4, "claude-opus-5-5 (backfill)"); // the backfill's own approval: never the daily allowance
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('catchup_spent', '0.5', 'x')").run();
		const g = new FakeGmail().add(alertMail("a1", "2026-10-13T06:20:00.000Z"));
		await runTick(makeEnv(db), D, { gmail: g }, [mailCheck]);
		const res = await handleRequest(get("/api/status", await signedIn(D.now())), makeEnv(db, { LEDGER_CATCHUP_APPROVED_USD: "10" }), CTX, { assets: TEST_ASSETS, deps: D });
		const body = await json(res);
		expect(body.diagnostic).toEqual({
			gmail_checked_at: START,
			gmail_check_running_since: null,
			daily_pull_day: "2026-10-13",
			work: [
				{ source: "daily", stage: "new", kind: null, count: 1, oldest: START },
				{ source: "owner_upload", stage: "new", kind: "statement", count: 2, oldest: "2026-10-13T05:30:00.000Z" },
			],
			spend_today: { day: "2026-10-13", daily_usd: 1.25, daily_cap_usd: 3, mail_reserve_usd: 1, catchup_usd: 0.5, older_months_usd: 0, backfill_usd: 4 },
			catchup: { approved_usd: 10, spent_usd: 0.5 },
		});
	});
});

// The live trouble of 13 Oct 2026: the two-year backfill paused at the owner's
// approval (US$44.77) on 12 Oct with one month and 23 statements left, and —
// because today's mail waited for the backfill to FINISH — no new mail was read.
describe("a paused backfill never holds up today's mail", () => {
	const MONTHS = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 9 - i, 1)).toISOString().slice(0, 7)); // 2026-10 … 2024-11
	const DBS_TEXT = "Your DBS card ending 9002 was charged SGD 8.40 at TOAST BOX on 13 Oct 2026.";
	const DBS_PATTERN: AlertPattern = { ...PATTERN, id: "dbs-1", institution: "dbs", from: "ibanking.alert@dbs.com" };
	const dbsAlert = (id: string, received_at: string) => mail({ id, from: "DBS <ibanking.alert@dbs.com>", subject: "Card Transaction Alert", text: DBS_TEXT, received_at });
	const PAUSED = { LEDGER_BACKFILL_APPROVED_USD: "44.77" };

	beforeEach(async () => {
		const book = emptyPlaybook();
		book.alert_patterns.push(PATTERN, DBS_PATTERN);
		await publishPlaybook(db, book, null, "senior", "test", "2026-10-01T00:00:00.000Z");
		// As live: on its last month, its approval spent, the alarm up; no daily pull or mail check yet.
		db.raw.prepare("DELETE FROM sync_state WHERE key IN ('phase', 'backfill', 'daily_pull')").run();
		db.raw
			.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'backfill', 'x'), ('backfill', ?, 'x'), ('backfill_spent', '44.77', 'x')")
			.run(JSON.stringify({ months: MONTHS, i: 23, listing: { q: "x", page: null, done: true, listed: 40 }, started_at: "2026-10-10T02:00:00.000Z", done: false }));
		db.raw.prepare("INSERT INTO alarms (key, message, raised_at) VALUES ('backfill_cap', 'The backfill has spent the amount you approved and has paused. To let it finish, raise LEDGER_BACKFILL_APPROVED_USD.', '2026-10-12T10:46:00.000Z')").run();
		// Its statements, found and waiting for money (not due again for a while).
		const later = "2026-10-14T00:00:00.000Z";
		const ins = db.raw.prepare("INSERT INTO work (gmail_id, source, month, kind, stage, attempts, not_before, created_at, updated_at) VALUES (?, 'backfill', ?, 'statement', ?, 0, ?, 'x', 'x')");
		ins.run("bs1", "2024-11", "waiting", later);
		ins.run("bs2", "2024-12", "waiting", later);
	});

	it("a patterned DBS alert from today becomes a line in one tick, without Claude, without touching the backfill's money", async () => {
		const g = new FakeGmail().add(dbsAlert("d1", "2026-10-13T06:10:00.000Z"));
		const claude = new FakeClaude(() => new Error("no model for a patterned alert"));
		const r = await engine({ gmail: g, claude }, PAUSED);
		expect(r.errors).toEqual([]);
		// The first check reached back to two days before the backfill started (nothing since is skipped).
		expect(g.queries[0]).toContain(`after:${Math.floor((new Date("2026-10-10T02:00:00.000Z").getTime() - OVERLAP_MS) / 1000)}`);
		expect(rows("SELECT account_id, merchant_raw, bill_minor, txn_date FROM lines")).toEqual([{ account_id: "debit-x", merchant_raw: "TOAST BOX", bill_minor: 840, txn_date: "2026-10-13" }]);
		expect(rows("SELECT source, stage, kind FROM work WHERE gmail_id = 'd1'")).toEqual([{ source: "daily", stage: "done", kind: "alert" }]);
		expect(claude.calls).toHaveLength(0);
		expect(rows("SELECT value FROM sync_state WHERE key = 'backfill_spent'")).toEqual([{ value: "44.77" }]);
		expect(rows("SELECT value FROM sync_state WHERE key = 'phase'")).toEqual([{ value: "backfill" }]);
		// The pause is told in plain words: what is left, what finishing costs, that new mail flows.
		const cap = openAlarms().find((a) => a.key === "backfill_cap")!;
		expect(cap.message).toContain("spent US$44.77 of the US$44.77 you approved");
		expect(cap.message).toContain("Still to read: 2 bank statements and 1 month of email (Nov 2024).");
		expect(cap.message).toMatch(/about US\$\d+\.\d\d more — to let it finish, raise LEDGER_BACKFILL_APPROVED_USD to US\$\d+\./);
		expect(cap.message).toContain("new mail is not held up");
	});

	it("an alert with no pattern is read from the daily allowance, never the backfill's spent approval", async () => {
		const g = new FakeGmail().add(alertMail("a1", "2026-10-13T06:10:00.000Z", "Card ending 1111: SGD 12.50 spent at KOPI CORNER, 13 Oct 2026"));
		const claude = new FakeClaude(() => ALERT);
		const r = await engine({ gmail: g, claude }, PAUSED);
		expect(r.errors).toEqual([]);
		expect(claude.calls).toHaveLength(1);
		expect(claude.calls[0]!.model).toBe(MODELS.LEDGER_MODEL_DAILY); // the daily reader, not the backfill's senior one
		expect(rows("SELECT merchant_raw FROM lines")).toEqual([{ merchant_raw: "KOPI CORNER" }]);
		expect(rows("SELECT model FROM api_spend")).toEqual([{ model: MODELS.LEDGER_MODEL_DAILY }]); // the daily allowance
		expect(rows("SELECT value FROM sync_state WHERE key = 'backfill_spent'")).toEqual([{ value: "44.77" }]);
	});

	it("uploads are still read, from the catch-up approval", async () => {
		await uploads(2);
		const claude = new FakeClaude((c: Call) => (isStatement(c) ? CITI : new Error("statements only")));
		const r = await engine({ gmail: new FakeGmail(), claude }, { ...PAUSED, LEDGER_CATCHUP_APPROVED_USD: "10" });
		expect(r.errors).toEqual([]);
		expect(claude.calls.length).toBeGreaterThan(0);
		expect(rows("SELECT DISTINCT source, stage FROM work WHERE source = 'owner_upload'")).toEqual([{ source: "owner_upload", stage: "done" }]);
		expect(rows("SELECT COUNT(*) AS n FROM lines WHERE account_id = 'card-c'")).toEqual([{ n: 1 }]); // the two copies are one statement's line
		expect(rows("SELECT DISTINCT model FROM api_spend")).toEqual([{ model: `${MODELS.LEDGER_MODEL_DAILY} (catch-up)` }]);
		expect(rows("SELECT value FROM sync_state WHERE key = 'backfill_spent'")).toEqual([{ value: "44.77" }]);
	});

	it("a message the backfill already listed or read is never read twice", async () => {
		// d1 listed by the backfill (this month, not yet read); d0 already read by it.
		db.raw.prepare("INSERT INTO work (gmail_id, source, month, stage, attempts, created_at, updated_at) VALUES ('d1', 'backfill', '2026-10', 'new', 0, 'x', 'x')").run();
		db.raw.prepare("INSERT INTO messages (gmail_id, received_at, classification, processed_at) VALUES ('d0', 'x', 'alert', 'x')").run();
		const g = new FakeGmail().add(dbsAlert("d0", "2026-10-13T05:00:00.000Z")).add(dbsAlert("d1", "2026-10-13T06:10:00.000Z"));
		const claude = new FakeClaude(() => new Error("no model for a patterned alert"));
		for (let i = 0; i < 3; i++) {
			const r = await engine({ gmail: g, claude }, PAUSED);
			expect(r.errors).toEqual([]);
			D.advance(16 * 60_000);
		}
		expect(rows("SELECT gmail_id, source, stage FROM work WHERE gmail_id IN ('d0', 'd1')")).toEqual([{ gmail_id: "d1", source: "backfill", stage: "done" }]);
		expect(rows("SELECT COUNT(*) AS n FROM lines")).toEqual([{ n: 1 }]);
		expect(rows("SELECT COUNT(*) AS n FROM messages WHERE gmail_id = 'd1'")).toEqual([{ n: 1 }]);
	});

	it("today's statement waits for the backfill to have read its months' alerts", async () => {
		const passed: boolean[] = [];
		const probe = { name: "probe", async run(t: Tick) { passed.push(backfillPassed(t, "2026-09"), backfillPassed(t, "2024-11"), backfillPassed(t, null)); } };
		await runTick(makeEnv(db), D, {}, [probe]); // on its last month: Sep 2026 is read, Nov 2024 not yet
		db.raw.prepare("UPDATE sync_state SET value = ? WHERE key = 'backfill'").run(JSON.stringify({ months: MONTHS, i: 0, listing: { q: "x", page: null, done: true, listed: 9 }, started_at: "x", done: false }));
		await runTick(makeEnv(db), D, {}, [probe]); // this month listed, not yet read
		db.raw.prepare("UPDATE sync_state SET value = 'daily' WHERE key = 'phase'").run();
		await runTick(makeEnv(db), D, {}, [probe]); // no backfill running
		expect(passed).toEqual([true, false, false, false, false, false, true, true, true]);
	});
});
