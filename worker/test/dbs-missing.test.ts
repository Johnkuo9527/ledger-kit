/// (18 Oct 2026): DBS's alert emails stopped reaching the ledger after
/// 13 Oct while Citi's and HSBC's kept coming. What makes that impossible to
/// miss again: the Gmail search names every DBS / POSB domain and the names
/// DBS's mail goes by; a learned sender can never break the search; a DBS
/// alert from an address of no bank is named to the owner (and never trusted); the
/// missed days are listed once more; and a bank that goes quiet raises an
/// alarm. Made-up amounts, names and card numbers throughout.

import { EXAMPLE_BANKS as BANKS } from "./helpers/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { emptyPlaybook } from "../../src/playbook";
import { applyEdits } from "../src/escalate";
import { workQueue } from "../src/pipeline";
import { bankRelist, gmailQuery, RELIST_FROM, senderDomains } from "../src/pull";
import { classify, unknownBankSender } from "../src/read";
import { alertSilence, SILENCE_EVERY_MS } from "../src/silence";
import { runTick, type Services, type Step } from "../src/tick";
import { FakeClaude, MODELS } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { makeDeps, makeEnv } from "./helpers/harness";

const W = [new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z")] as const;
const fromGroup = (q: string) => /^\(from:\(([^)]*)\)/.exec(q)?.[1]?.split(" OR ") ?? [];

const PAYNOW = [
	"Dear Sir / Madam,",
	"We refer to your PayNow transfer dated 16 Oct 19:20. We are pleased to confirm that the transaction was completed.",
	"Date & Time: 16 Oct 19:20 (SGT)",
	"Amount: SGD5.80",
	"From: DBS Multiplier Account A/C ending 9001",
	"To: KOPI CORNER PTE. LTD. (UEN ending 123A)",
].join("\n");

describe("the Gmail search finds DBS however it sends", () => {
	it("every DBS / POSB domain, and DBS's mail names: iBanking, digibank, PayLah, POSB", () => {
		const from = fromGroup(gmailQuery(senderDomains(undefined, null, BANKS), BANKS.searchNames(), "Ledger <ledger@example.com>", ...W));
		for (const d of ["dbs.com", "dbs.com.sg", "posb.com.sg", "ibanking", "digibank", "paylah", "posb"]) expect(from).toContain(d);
		expect(from).toContain("hsbc"); // HSBC's still there
	});

	it("The owner's own list of senders (the var) adds to the banks, never replaces them", () => {
		expect(senderDomains("shop.example", null, BANKS)).toEqual(expect.arrayContaining(["dbs.com", "dbs.com.sg", "posb.com.sg", "citibank.com.sg", "shop.example"]));
	});

	it("a learned sender that is not one plain domain is left out, so it cannot change what the search means", () => {
		const book = emptyPlaybook();
		book.senders.receipts.push("DBS iBanking Alerts", "@shop.example", "(x)", "-dbs.com", 'a"b.example', "@ok-mail.example");
		book.senders.statements.push({ institution: "dbs", from: "estatement@dbs.com.sg", account_id: "bank-x", password_secret: null });
		const domains = senderDomains(undefined, book, BANKS);
		expect(domains).toEqual(["dbs.com", "dbs.com.sg", "posb.com.sg", "hsbc.com.sg", "hsbc.com", "hsbc.com.hk", "citibank.com.sg", "citibank.com", "citi.com", "taishinbank.com.tw" /* every domain on the owner's bank list (the example seed's) */, "shop.example", "ok-mail.example"]);
		const q = gmailQuery([...domains, "dbs ibanking alerts"], BANKS.searchNames(), "Ledger <ledger@example.com>", ...W);
		expect(fromGroup(q).every((w) => /^[a-z0-9.-]+$/.test(w))).toBe(true);
	});
});

describe("the likeliest way DBS fell out of the search (18 Oct 2026)", () => {
	// The escalation reader may add RECEIPT senders from what it read (escalate.ts
	// applyEdits). Nothing made such a sender one word: "kopi corner sg.com" passed
	// (it has a dot, touches no bank) and went straight into from:( … ). In Gmail
	// "a OR b c OR d" is (a OR b) AND (c OR d), so the from: group then matched
	// almost nothing — mail still came in only through category:purchases or a
	// receipt-like subject, which card alerts can be filed under and DBS's
	// "iBanking Alerts" is not.
	it("a receipt sender the escalation reader adds can no longer split the from: group", () => {
		const book = applyEdits(emptyPlaybook(), { add_senders: [{ kind: "receipts", institution: null, from: "Kopi Corner SG.com" }], add_merchant_aliases: [], add_category_rules: [], add_own_names: [], notes_append: null }, BANKS);
		expect(book.senders.receipts).toEqual(["kopi corner sg.com"]); // accepted as before: it is only a receipt sender
		const from = fromGroup(gmailQuery(senderDomains(undefined, book, BANKS), BANKS.searchNames(), "Ledger <ledger@example.com>", ...W));
		expect(from).toContain("dbs.com");
		expect(from.some((w) => w.includes(" "))).toBe(false);
	});
});

describe("listing is not trusting", () => {
	it("an 'iBanking Alerts' email from an address of no bank: a receipt, and the owner is told the address as DBS's", () => {
		const odd = mail({ id: "o", from: "iBanking Alerts <ibanking.alert@alerts-mailer.example>", subject: "iBanking Alerts", text: PAYNOW });
		expect(classify(odd, null, BANKS)).toBe("receipt");
		expect(unknownBankSender(odd, null, BANKS)).toEqual({ bank: "dbs", address: "ibanking.alert@alerts-mailer.example" });
		const bare = mail({ id: "b", from: "ibanking.alert@other-mailer.example", subject: "iBanking Alerts", text: PAYNOW });
		expect(unknownBankSender(bare, null, BANKS)).toEqual({ bank: "dbs", address: "ibanking.alert@other-mailer.example" });
		expect(unknownBankSender(mail({ id: "d", from: "digibank Alerts <alerts@x.example>", subject: "Transaction alert" }), null, BANKS)?.bank).toBe("dbs");
		expect(unknownBankSender(mail({ id: "p", from: "PayLah! <noreply@y.example>", subject: "PayLah! Alert" }), null, BANKS)?.bank).toBe("dbs");
	});

	it("DBS mail from dbs.com.sg is a DBS alert only when Gmail vouches for it", () => {
		expect(classify(mail({ id: "sg", from: "iBanking Alerts <ibanking.alert@dbs.com.sg>", subject: "iBanking Alerts", text: PAYNOW }), null, BANKS)).toBe("alert");
		expect(classify(mail({ id: "spoof", from: "iBanking Alerts <ibanking.alert@dbs.com.sg>", subject: "iBanking Alerts", text: PAYNOW, auth: [] }), null, BANKS)).toBe("receipt");
	});
});

// --------------------------------------------------------- through the engine

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
	// The backfill is long done; the mail check and today's daily pull ran a few minutes ago.
	db.raw
		.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'daily', 'x'), ('backfill', ?, 'x'), ('daily_pull', ?, 'x'), ('mail_check', ?, 'x')")
		.run(
			JSON.stringify({ done: true, started_at: "2026-09-01T00:00:00.000Z" }),
			JSON.stringify({ day: "2026-10-18", started_at: "2026-10-17T22:00:00.000Z", q: "x", page: null, done: true, listed: 0 }),
			JSON.stringify({ started_at: "2026-10-18T03:55:00.000Z", ok_at: "2026-10-18T03:55:30.000Z", q: "x", page: null, done: true, listed: 0 }),
		);
});
afterEach(() => db.close());

const NOW = "2026-10-18T04:00:00.000Z"; // 12:00 in Singapore
const SUB = { ...MODELS, LEDGER_READER: "subscription" };
const noClaude = () => new FakeClaude(() => new Error("a built-in reading needs no model"));
const tick = (D: ReturnType<typeof makeDeps>, svc: Services, steps: Step[]) => runTick(makeEnv(db, SUB), D, svc, steps);
const rows = (sql: string, ...args: unknown[]) => db.raw.prepare(sql).all(...(args as never[]));
const openAlarms = () => rows("SELECT key, message FROM alarms WHERE cleared_at IS NULL ORDER BY key") as { key: string; message: string }[];

describe("the missed days are listed once more", () => {
	it("from 13 Oct 00:00 Singapore: what was never read is queued and read; what was read is not; only once", async () => {
		const D = makeDeps(NOW);
		const g = new FakeGmail().add(
			mail({ id: "dbs-16", from: "DBS <ibanking.alert@dbs.com>", subject: "iBanking Alerts", text: PAYNOW, received_at: "2026-10-16T11:20:00.000Z" }),
			mail({ id: "read-14", from: "Citi <alerts@citibank.com.sg>", subject: "Citi Alerts", received_at: "2026-10-14T03:00:00.000Z" }),
			mail({ id: "old-12", from: "DBS <ibanking.alert@dbs.com>", subject: "iBanking Alerts", received_at: "2026-10-12T15:59:00.000Z" }),
		);
		db.raw.prepare("INSERT INTO messages (gmail_id, received_at, classification, processed_at) VALUES ('read-14', '2026-10-14T03:00:00.000Z', 'alert', 'x')").run();
		await tick(D, { gmail: g, claude: noClaude() }, [bankRelist, workQueue]);
		expect(g.queries[0]).toContain(`after:${new Date(RELIST_FROM).getTime() / 1000}`);
		expect(g.queries[0]).toContain("ibanking");
		expect(rows("SELECT gmail_id, source FROM work")).toEqual([{ gmail_id: "dbs-16", source: "daily" }]);
		expect(rows("SELECT account_id, orig_minor, txn_date FROM lines")).toEqual([{ account_id: "bank-x", orig_minor: 580, txn_date: "2026-10-16" }]);
		// Once: the next ticks list nothing more.
		D.advance(86_400_000);
		await tick(D, { gmail: g, claude: noClaude() }, [bankRelist]);
		expect(g.calls.list).toBe(1);
	});
});

describe("a ledger that began after the missed days", () => {
	it("never lists them again: its own backfill already read that time", async () => {
		const D = makeDeps("2027-03-01T04:00:00.000Z");
		db.raw.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('backfill', ?, 'x')").run(JSON.stringify({ started_at: "2027-02-20T00:00:00.000Z", done: true, months: ["2027-02"], i: 1 }));
		const g = new FakeGmail();
		await tick(D, { gmail: g, claude: noClaude() }, [bankRelist]);
		expect(g.calls.list).toBe(0);
		expect(JSON.parse((db.raw.prepare("SELECT value FROM sync_state WHERE key = 'bank_relist'").get() as { value: string }).value)).toMatchObject({ done: true, listed: 0 });
	});
});

describe("a bank gone quiet", () => {
	let n = 0;
	function alertFrom(institution: string, receivedAt: string, type = "alert") {
		const id = `ev${++n}`;
		if (type === "alert") db.raw.prepare("INSERT INTO messages (gmail_id, received_at, classification, processed_at) VALUES (?, ?, 'alert', ?)").run(`m-${id}`, receivedAt, NOW);
		db.raw
			.prepare("INSERT INTO evidence (id, type, message_id, fingerprint, institution, txn_date, currency, amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?, 'SGD', 100, ?)")
			// created_at = now for every row: when it was READ must not count, only when it arrived.
			.run(id, type, type === "alert" ? `m-${id}` : null, `fp-${id}`, institution, receivedAt.slice(0, 10), type === "alert" ? NOW : receivedAt);
	}
	const MESSAGE = "DBS 已經 5 天沒有寄交易通知 email 來了 — 請確認 DBS app 的 email 通知，或告訴我們寄件人換了";

	it("DBS silent since 13 Oct while Citi alerts and Apple Pay taps keep coming: the alarm, in the owner's words", async () => {
		alertFrom("dbs", "2026-10-13T06:29:00.000Z");
		alertFrom("citi", "2026-10-17T09:00:00.000Z");
		alertFrom("hsbc", "2026-10-17T10:00:00.000Z");
		alertFrom("citi", "2026-10-18T01:00:00.000Z", "apple_pay_shortcut");
		await tick(makeDeps(NOW), { gmail: new FakeGmail() }, [alertSilence]);
		expect(openAlarms()).toEqual([{ key: "alerts_silent:DBS", message: MESSAGE }]);
	});

	it("…and clears the moment a DBS alert is read", async () => {
		alertFrom("dbs", "2026-10-13T06:29:00.000Z");
		alertFrom("citi", "2026-10-17T09:00:00.000Z");
		const D = makeDeps(NOW);
		await tick(D, { gmail: new FakeGmail() }, [alertSilence]);
		expect(openAlarms().map((a) => a.key)).toEqual(["alerts_silent:DBS"]);
		const g = new FakeGmail().add(mail({ id: "dbs-18", from: "DBS <ibanking.alert@dbs.com>", subject: "iBanking Alerts", text: PAYNOW, received_at: "2026-10-18T04:05:00.000Z" }));
		db.raw.prepare("INSERT INTO work (gmail_id, source, stage, attempts, created_at, updated_at) VALUES ('dbs-18', 'daily', 'new', 0, 'x', 'x')").run();
		D.advance(10 * 60_000);
		await tick(D, { gmail: g, claude: noClaude() }, [workQueue, alertSilence]);
		expect(openAlarms()).toEqual([]);
		// The next look (hours later) agrees: DBS is speaking again.
		D.advance(SILENCE_EVERY_MS);
		await tick(D, { gmail: g }, [alertSilence]);
		expect(openAlarms()).toEqual([]);
	});

	it("no alarm: the owner quiet everywhere, a bank never heard from, 台新 (no alerts), fewer than 3 days", async () => {
		alertFrom("dbs", "2026-10-13T06:29:00.000Z");
		alertFrom("citi", "2026-10-14T09:00:00.000Z"); // the other banks quiet too: the owner is simply not spending
		alertFrom("taishin", "2026-10-01T00:00:00.000Z");
		await tick(makeDeps(NOW), { gmail: new FakeGmail() }, [alertSilence]);
		expect(openAlarms()).toEqual([]);
		alertFrom("hsbc", "2026-10-15T05:00:00.000Z"); // 2 days 23 hours ago
		alertFrom("citi", "2026-10-17T09:00:00.000Z");
		db.raw.prepare("DELETE FROM sync_state WHERE key = 'alert_silence_at'").run(); // look again now
		await tick(makeDeps(NOW), { gmail: new FakeGmail() }, [alertSilence]);
		expect(openAlarms().map((a) => a.key)).toEqual(["alerts_silent:DBS"]); // not HSBC, not 台新
	});

	it("looks at most every 3 hours, one query; never while Gmail is signed out", async () => {
		alertFrom("dbs", "2026-10-13T06:29:00.000Z");
		alertFrom("citi", "2026-10-17T09:00:00.000Z");
		db.raw.prepare("INSERT INTO alarms (key, message, raised_at) VALUES ('google_signin', 'x', 'x')").run();
		const D = makeDeps(NOW);
		await tick(D, { gmail: new FakeGmail() }, [alertSilence]);
		expect(openAlarms().map((a) => a.key)).toEqual(["google_signin"]);
		db.raw.prepare("DELETE FROM alarms").run();
		await tick(D, { gmail: new FakeGmail() }, [alertSilence]);
		expect(openAlarms().map((a) => a.key)).toEqual(["alerts_silent:DBS"]);
		db.raw.prepare("DELETE FROM alarms").run();
		D.advance(SILENCE_EVERY_MS - 60_000);
		await tick(D, { gmail: new FakeGmail() }, [alertSilence]);
		expect(openAlarms()).toEqual([]); // not looked again yet
		D.advance(60_000);
		await tick(D, { gmail: new FakeGmail() }, [alertSilence]);
		expect(openAlarms().map((a) => a.key)).toEqual(["alerts_silent:DBS"]);
	});
});
