/// A bank the code has never heard of, at a home that is not Singapore's: a
/// made-up UK bank ("Thames Bank", thamesbank.example) listed ONLY in the owner's
/// seed file, a pound-sterling home in London. Its mail is found, trusted only
/// when Gmail vouches for it, read into lines by the reader, learned as a
/// pattern, and its statement merges with the alerts. Spoofed and unlisted mail
/// adds nothing. Every bank, card, merchant and amount is MADE UP; every figure
/// is worked by hand first.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { setHome, SINGAPORE } from "../../src/home";
import { seedSql, type SeedFile } from "../../src/seed";
import { learnPatterns } from "../src/learn";
import { alertFromAnswer } from "../src/read";
import { workQueue } from "../src/pipeline";
import { mailCheck } from "../src/pull";
import { runTick, type Services } from "../src/tick";
import { FakeClaude, MODELS, type Call } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { makeDeps, makeEnv } from "./helpers/harness";

const PDF = new Uint8Array(readFileSync(new URL("./fixtures/statement-aes-256.pdf", import.meta.url)));
const PLAIN_PDF = new Uint8Array(readFileSync(new URL("./fixtures/statement-plain.pdf", import.meta.url)));
const PW = "made-up-pw-1234";

const SEED: SeedFile = {
	banks: [{ institution: "thames", name: "Thames Bank", domains: ["thamesbank.example"], sender_names: ["thamesbank"] }],
	accounts: [
		{ id: "thames-card", institution: "thames", kind: "credit_card", name: "Thames card 6001", last4: "6001", currency: "GBP" },
		{ id: "cash", institution: "cash", kind: "cash", name: "Cash", last4: null, currency: "GBP" },
	],
};
const HOME = { LEDGER_HOME_CURRENCY: "GBP", LEDGER_TIMEZONE: "Europe/London", LEDGER_HOME_COUNTRY: "GB" };

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
beforeEach(() => {
	db = freshDb();
	db.raw.exec(seedSql(SEED));
	// 1 USD = 0.80 GBP on 6 Oct (stored X → GBP, the home currency).
	db.raw.prepare("INSERT INTO fx_rates (date, currency, quote, rate, source) VALUES ('2026-10-06', 'USD', 'GBP', 0.8, 'test')").run();
	D = makeDeps();
});
afterEach(() => {
	db.close();
	setHome(SINGAPORE);
});

const tick = (svc: Services, steps = [workQueue, learnPatterns], env: Record<string, string> = {}) => runTick(makeEnv(db, { ...MODELS, ...HOME, ...env }), D, svc, steps);
const queue = (source: "daily" | "backfill", ...ids: string[]) => {
	for (const id of ids) db.raw.prepare("INSERT INTO work (gmail_id, source, month, stage, attempts, created_at, updated_at) VALUES (?, ?, ?, 'new', 0, 'x', 'x')").run(id, source, source === "backfill" ? "2026-10" : null);
};
const evidence = () => db.raw.prepare("SELECT type, institution, last4, currency, amount_minor, merchant_raw, txn_date, message_id FROM evidence ORDER BY message_id, type").all() as Record<string, unknown>[];
const cardLines = () => db.raw.prepare("SELECT txn_date, orig_currency, orig_minor, bill_minor, bill_status, home_minor, home_status, state FROM lines WHERE account_id = 'thames-card' AND state <> 'void' ORDER BY txn_date").all();
const openAlarms = () => (db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL ORDER BY key").all() as { key: string }[]).map((a) => a.key);

const FROM = "Thames Bank <alerts@thamesbank.example>";
const alertText = (amount: string, merchant: string, date: string) => `Your Thames card ending 6001 was used for ${amount} at ${merchant} on ${date}.`;
const TEXTS = {
	a1: alertText("£12.50", "CORNER CAFE LONDON", "07/10/2026"),
	a2: alertText("USD 20.00", "EXAMPLE STORE NEW YORK", "06/10/2026"),
	a3: alertText("£3.20", "NEWSAGENT LONDON", "05/10/2026"),
	a4: alertText("£9.90", "NOODLE BAR LONDON", "08/10/2026"),
	s1: alertText("£99.00", "FAKE SHOP", "07/10/2026"),
	u1: alertText("£45.00", "SOMEWHERE", "07/10/2026"),
};
// What the reader makes of each alert: amounts as printed, without the currency.
const READING: Record<string, object> = {
	a1: { currency: "GBP", amount: "12.50", merchant: "CORNER CAFE LONDON", country: "GB", date: "2026-10-07" },
	a2: { currency: "USD", amount: "20.00", merchant: "EXAMPLE STORE NEW YORK", country: "US", date: "2026-10-06" },
	a3: { currency: "GBP", amount: "3.20", merchant: "NEWSAGENT LONDON", country: "GB", date: "2026-10-05" },
};
// The model cannot know this bank: it says "other" (or even names another bank) — the sender decides.
const ALERT = (id: string) => ({ is_transaction: true, institution: id === "a1" ? "hsbc" : "other", last4: "6001", direction: "out", time: null, kind_hint: "purchase", confidence: "sure", note: "", ...READING[id] });
const RECEIPT_NO = { is_receipt: false, merchant: "", currency: "GBP", amount: "0.00", direction: "out", date: "2026-10-07", order_id: null, items: [], flights: [], hotels: [], confidence: "sure", note: "" };
const PATTERN = {
	subject: null,
	body: "ending (?<last4>\\d{4}) was used for (?<currency>£|[A-Z]{3}) ?(?<amount>[\\d,.]+) at (?<merchant>.+?) on (?<date>\\d{2}/\\d{2}/\\d{4})",
	kind_hint: "purchase",
	default_currency: "GBP",
	date_format: "DD/MM/YYYY",
	credit: false,
};
// The statement: 12.50 + 16.40 (the USD 20.00 as billed) + 3.20 = 32.10 = closing 32.10 − opening 0.00. ✓
const STATEMENT = {
	institution: "other",
	statements: [
		{
			last4: "6001",
			period_start: "2026-09-16",
			period_end: "2026-10-15",
			currency: "GBP",
			opening_balance: "0.00",
			opening_is_credit: false,
			closing_balance: "32.10",
			closing_is_credit: false,
			minimum_due: "5.00",
			due_date: "2026-11-05",
			payments_credited: null,
			lines: [
				{ seq: 1, date: "2026-10-05", post_date: null, description: "NEWSAGENT LONDON", currency: "GBP", amount: "3.20", bill_currency: null, bill_amount: null, direction: "out", country: "GB", kind_hint: "purchase", card_last4: null },
				{ seq: 2, date: "2026-10-06", post_date: null, description: "EXAMPLE STORE NEW YORK", currency: "USD", amount: "20.00", bill_currency: "GBP", bill_amount: "16.40", direction: "out", country: "US", kind_hint: "purchase", card_last4: null },
				{ seq: 3, date: "2026-10-07", post_date: null, description: "CORNER CAFE LONDON", currency: "GBP", amount: "12.50", bill_currency: null, bill_amount: null, direction: "out", country: "GB", kind_hint: "purchase", card_last4: null },
			],
		},
	],
	confidence: "sure",
	note: "",
};

function claude() {
	return new FakeClaude((c: Call) => {
		if (c.system.startsWith("You write ONE regular expression")) return PATTERN;
		if (c.system.startsWith("You read the text of ONE card or bank statement")) return STATEMENT;
		if (c.system.startsWith("You read ONE bank alert")) {
			const id = (Object.keys(TEXTS) as (keyof typeof TEXTS)[]).find((k) => c.user.includes(TEXTS[k]))!;
			return ALERT(id);
		}
		return RECEIPT_NO;
	});
}

function mailbox(): FakeGmail {
	const g = new FakeGmail();
	for (const id of ["a1", "a2", "a3"] as const) g.add(mail({ id, from: FROM, subject: "Card payment", text: TEXTS[id] }));
	g.add(mail({ id: "s1", from: FROM, subject: "Card payment", text: TEXTS.s1, auth: [] })); // spoofed: Gmail vouches for nothing
	g.add(mail({ id: "u1", from: "Other Bank <alerts@otherbank.example>", subject: "Card payment", text: TEXTS.u1 })); // genuine, but not the owner's bank
	g.add(mail({ id: "st1", from: "Thames Bank <statements@thamesbank.example>", subject: "Your statement", pdfs: [{ filename: "statement.pdf", attachment_id: "att1", size: PDF.length }] }));
	g.attachments.set("st1/att1", PDF);
	return g;
}

describe("a bank listed only in the owner's seed file (Thames Bank), at a pound-sterling home", () => {
	it("is searched for by its own domain and sender name", async () => {
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'daily', 'x')").run();
		const g = new FakeGmail();
		await tick({ gmail: g, claude: null }, [mailCheck]);
		expect(g.queries[0]).toContain("thamesbank.example");
		expect(g.queries[0]).toMatch(/\bthamesbank\b/);
		// The kit's example banks are not this owner's: never searched for him.
		expect(g.queries[0]).not.toContain("dbs.com");
	});

	it("trusted alerts become lines on its card in pounds; a spoof and an unlisted bank add nothing; a pattern is learned; the statement merges", async () => {
		const g = mailbox();
		const c = claude();
		// The backfill reads with the senior reader, so each alert is also a sample to learn from.
		queue("backfill", "a1", "a2", "a3", "s1", "u1");
		const r = await tick({ gmail: g, claude: c }, [workQueue, learnPatterns], { LEDGER_BACKFILL_APPROVED_USD: "50" });

		// Alerts: on Thames's card, whatever the model called the bank (a1 it called "hsbc").
		// a2: USD 20.00 × 0.80 × (1 + 3.25% default markup) = 16.52 GBP → 1652 pence, an estimate.
		expect(evidence()).toEqual([
			{ type: "alert", institution: "thames", last4: "6001", currency: "GBP", amount_minor: 1250, merchant_raw: "CORNER CAFE LONDON", txn_date: "2026-10-07", message_id: "a1" },
			{ type: "alert", institution: "thames", last4: "6001", currency: "USD", amount_minor: 2000, merchant_raw: "EXAMPLE STORE NEW YORK", txn_date: "2026-10-06", message_id: "a2" },
			{ type: "alert", institution: "thames", last4: "6001", currency: "GBP", amount_minor: 320, merchant_raw: "NEWSAGENT LONDON", txn_date: "2026-10-05", message_id: "a3" },
		]);
		expect(cardLines()).toEqual([
			{ txn_date: "2026-10-05", orig_currency: "GBP", orig_minor: 320, bill_minor: 320, bill_status: "exact", home_minor: 320, home_status: "exact", state: "open" },
			{ txn_date: "2026-10-06", orig_currency: "USD", orig_minor: 2000, bill_minor: 1652, bill_status: "estimate", home_minor: 1652, home_status: "estimate", state: "open" },
			{ txn_date: "2026-10-07", orig_currency: "GBP", orig_minor: 1250, bill_minor: 1250, bill_status: "exact", home_minor: 1250, home_status: "exact", state: "open" },
		]);
		// The spoof and the unlisted bank were read only as receipts (and were none): nothing from them.
		const kinds = db.raw.prepare("SELECT gmail_id, classification FROM messages WHERE gmail_id IN ('s1', 'u1') ORDER BY gmail_id").all();
		expect(kinds).toEqual([
			{ gmail_id: "s1", classification: "ignored" },
			{ gmail_id: "u1", classification: "ignored" },
		]);
		// The owner hears that mail claiming to be Thames failed Gmail's check — named by his own list.
		expect(openAlarms()).toEqual(["bank_unverified:THAMES"]);
		const msg = (db.raw.prepare("SELECT message FROM alarms WHERE key = 'bank_unverified:THAMES'").get() as { message: string }).message;
		expect(msg).toContain("Thames Bank");

		// Three senior readings of one sender: a pattern was learned, filed under THIS bank (not the model's say).
		expect(r.counts.pattern_learned).toBe(1);
		const book = JSON.parse((db.raw.prepare("SELECT body_json FROM playbook_versions ORDER BY version DESC").get() as { body_json: string }).body_json);
		expect(book.alert_patterns[0]).toMatchObject({ institution: "thames", from: "alerts@thamesbank.example" });

		// A new alert is read by the pattern, free: "£9.90" → GBP 990 pence on the card.
		g.add(mail({ id: "a4", from: FROM, subject: "Card payment", text: TEXTS.a4, received_at: "2026-10-08T12:00:00.000Z" }));
		queue("daily", "a4");
		const calls = c.calls.length;
		await tick({ gmail: g, claude: c });
		expect(c.calls.length).toBe(calls);
		expect(evidence().filter((e) => e.message_id === "a4")).toEqual([{ type: "alert", institution: "thames", last4: "6001", currency: "GBP", amount_minor: 990, merchant_raw: "NOODLE BAR LONDON", txn_date: "2026-10-08", message_id: "a4" }]);

		// The statement: each printed line joins its alert's line; the dollar purchase is billed 16.40.
		queue("daily", "st1");
		// Its PDF is locked; the password is the worker secret named after the bank on his list.
		await tick({ gmail: g, claude: c }, [workQueue], { LEDGER_PDF_PW_THAMES: PW });
		expect(cardLines()).toEqual([
			// A pound amount was exact all along; the statement reconciles it. The dollar estimate becomes what was billed.
			{ txn_date: "2026-10-05", orig_currency: "GBP", orig_minor: 320, bill_minor: 320, bill_status: "exact", home_minor: 320, home_status: "exact", state: "reconciled" },
			{ txn_date: "2026-10-06", orig_currency: "USD", orig_minor: 2000, bill_minor: 1640, bill_status: "confirmed", home_minor: 1640, home_status: "confirmed", state: "reconciled" },
			{ txn_date: "2026-10-07", orig_currency: "GBP", orig_minor: 1250, bill_minor: 1250, bill_status: "exact", home_minor: 1250, home_status: "exact", state: "reconciled" },
			// After the statement's period: still open.
			{ txn_date: "2026-10-08", orig_currency: "GBP", orig_minor: 990, bill_minor: 990, bill_status: "exact", home_minor: 990, home_status: "exact", state: "open" },
		]);
		const st = db.raw.prepare("SELECT account_id, currency, closing_balance_minor FROM statements").all();
		expect(st).toEqual([{ account_id: "thames-card", currency: "GBP", closing_balance_minor: 3210 }]);
		// One line per purchase: three alerts + three statement lines on three lines, never six.
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM evidence WHERE type = 'statement_line'").get()).toEqual({ n: 3 });
	});

	it("an unlocked statement PDF is refused — unless the owner's list says this bank sends them unlocked", async () => {
		const plain = (g: FakeGmail) => {
			g.add(mail({ id: "st2", from: "Thames Bank <statements@thamesbank.example>", subject: "Your statement", pdfs: [{ filename: "statement.pdf", attachment_id: "att1", size: PLAIN_PDF.length }] }));
			g.attachments.set("st2/att1", PLAIN_PDF);
			return g;
		};
		const g = plain(new FakeGmail());
		queue("daily", "st2");
		const r = await tick({ gmail: g, claude: claude() }, [workQueue]);
		expect(r.counts.statement_unencrypted_refused).toBe(1);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM statements").get()).toEqual({ n: 0 });
		// The owner says Thames sends its statements without a password: the same mail is read.
		db.raw.exec(seedSql({ ...SEED, banks: [{ ...SEED.banks[0]!, pdf_password: false }] }));
		db.raw.prepare("UPDATE work SET stage = 'new', attempts = 0, error = NULL WHERE gmail_id = 'st2'").run();
		D.advance(60_000);
		await tick({ gmail: g, claude: claude() }, [workQueue]);
		expect(db.raw.prepare("SELECT account_id, closing_balance_minor FROM statements").all()).toEqual([{ account_id: "thames-card", closing_balance_minor: 3210 }]);
	});

	it("with no bank listed at all, nothing is trusted and the owner is told", async () => {
		db.raw.exec("UPDATE sync_state SET value = '[]' WHERE key = 'banks'");
		const g = mailbox();
		queue("daily", "a1");
		await tick({ gmail: g, claude: claude() });
		expect(evidence()).toEqual([]);
		expect(openAlarms()).toContain("no_banks");
	});

	it("a reading in a euro bank's print: '1.234,50' is EUR 1,234.50, on the bank Gmail vouched for", () => {
		// 1.234,50 = one thousand two hundred thirty-four euros fifty = 123450 cents.
		const ev = alertFromAnswer({ is_transaction: true, institution: "dbs", last4: "7001", currency: "EUR", amount: "1.234,50", direction: "out", merchant: "MÖBELHAUS BEISPIEL", country: "DE", date: "2026-10-07", time: null, kind_hint: "purchase", confidence: "sure", note: "" }, "e1", "examplebank");
		expect(ev).toMatchObject({ institution: "examplebank", currency: "EUR", amount_minor: 123450 });
	});
});
