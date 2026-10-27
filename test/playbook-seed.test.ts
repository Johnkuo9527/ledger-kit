import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	applyAlertPattern,
	canonicalJson,
	defaultPdfSecretName,
	emptyPlaybook,
	parseAlertDate,
	playbookPrompt,
	validatePlaybook,
	type AlertPattern,
	type Playbook,
} from "../src/playbook";
import { seedAccounts, seedProblems, seedSql, walletRows, type SeedFile } from "../src/seed";
import { freshDb } from "./helpers/sqlite-db";

// A MADE-UP bank and alert wording. Real per-bank patterns are written by the
// senior model into the playbook from the owner's actual alerts.
const PATTERN: AlertPattern = {
	id: "testbank-card",
	institution: "testbank",
	from: "alerts@testbank.example",
	subject: "Card transaction",
	body: "(?<currency>[A-Z]{3}) (?<amount>[\\d,]+(?:\\.\\d{2})?) was charged on your card ending (?<last4>\\d{4}) at (?<merchant>.+?) on (?<date>\\d{1,2} [A-Za-z]{3} \\d{4}) (?<time>\\d{2}:\\d{2})",
	kind_hint: "purchase",
	default_currency: "SGD",
	date_format: "D MMM YYYY",
};
const REFUND: AlertPattern = { ...PATTERN, id: "testbank-refund", subject: "Refund", body: "refund of (?<amount>[\\d.]+) to card (?<last4>\\d{4}) from (?<merchant>.+)\\.", kind_hint: "refund", credit: true };

describe("reading a bank alert with no model call", () => {
	const email = {
		from: "alerts@testbank.example",
		subject: "Card transaction alert",
		body: "Dear customer, SGD 45.60 was charged on your card ending 1111 at KOPI CORNER on 5 Mar 2026 14:32. If this was not you…",
		received_date: "2026-03-05",
	};

	it("pulls out every field", () => {
		expect(applyAlertPattern([PATTERN], email)).toEqual({
			pattern_id: "testbank-card",
			institution: "testbank",
			kind_hint: "purchase",
			currency: "SGD",
			amount_minor: 4560,
			last4: "1111",
			merchant_raw: "KOPI CORNER",
			merchant_country: null,
			txn_date: "2026-03-05",
			txn_time: "14:32",
		});
	});

	it("reads yen printed with .00 as whole yen", () => {
		const r = applyAlertPattern([PATTERN], { ...email, body: email.body.replace("SGD 45.60", "JPY 1,200.00") });
		expect(r).toMatchObject({ currency: "JPY", amount_minor: 1200 });
	});

	it("makes a credit alert negative", () => {
		const r = applyAlertPattern([PATTERN, REFUND], { ...email, subject: "Refund", body: "A refund of 12.35 to card 1111 from ZARA ION." });
		expect(r).toMatchObject({ pattern_id: "testbank-refund", amount_minor: -1235, kind_hint: "refund", txn_date: "2026-03-05" });
	});

	it("returns nothing for another sender or an unknown wording — the daily model reads those", () => {
		expect(applyAlertPattern([PATTERN], { ...email, from: "alerts@other.example" })).toBeNull();
		expect(applyAlertPattern([PATTERN], { ...email, body: "Your statement is ready." })).toBeNull();
		expect(applyAlertPattern([{ ...PATTERN, from: "@testbank.example" }], email)?.amount_minor).toBe(4560);
	});

	it("dates an alert that omits the year by the email's own date", () => {
		expect(parseAlertDate("28 Dec", "D MMM", "2026-01-02")).toBe("2025-12-28");
		expect(parseAlertDate("2 Jan", "D MMM", "2026-01-02")).toBe("2026-01-02");
		expect(parseAlertDate("31/02/2026", "DD/MM/YYYY", "2026-03-01")).toBeNull();
		expect(parseAlertDate("2026/03/05", "YYYY/MM/DD", "2026-03-05")).toBe("2026-03-05");
	});
});

describe("the playbook", () => {
	const valid = (): Playbook => ({
		...emptyPlaybook(),
		alert_patterns: [PATTERN],
		categories: ["Food"],
		category_rules: [{ merchant_key: "KOPI CORNER", category: "Food" }],
		senders: { alerts: [], statements: [{ institution: "testbank", from: "statements@testbank.example", account_id: "card-a", password_secret: "LEDGER_PDF_PW_TESTBANK" }], receipts: [], ignore: [] },
	});

	it("accepts a well-formed one", () => {
		expect(validatePlaybook(emptyPlaybook())).toEqual([]);
		expect(validatePlaybook(valid())).toEqual([]);
	});

	it("refuses a password written into it", () => {
		const p = valid();
		p.senders.statements[0]!.password_secret = "hunter2-real-password";
		expect(validatePlaybook(p).join()).toMatch(/NAME a worker secret/);
		p.senders.statements[0]!.password_secret = "MY_SECRET"; // a name, but not one of ours
		expect(validatePlaybook(p).join()).toMatch(/LEDGER_PDF_PW_/);
		expect(defaultPdfSecretName("taishin")).toBe("LEDGER_PDF_PW_TAISHIN");
	});

	it("refuses broken or useless patterns and rules", () => {
		const p = valid();
		p.alert_patterns.push({ ...PATTERN, id: "bad", body: "(unclosed" });
		p.alert_patterns.push({ ...PATTERN, id: "noamount", body: "charged at (?<merchant>.+)" });
		p.alert_patterns.push({ ...PATTERN });
		p.category_rules.push({ merchant_key: "X", category: "Nonexistent" });
		const problems = validatePlaybook(p).join("\n");
		expect(problems).toMatch(/bad:/);
		expect(problems).toMatch(/noamount: needs an \(\?<amount>/);
		expect(problems).toMatch(/used twice/);
		expect(problems).toMatch(/'Nonexistent' is not in categories/);
		expect(validatePlaybook({ schema: 2 })).not.toEqual([]);
		expect(validatePlaybook(null)).toEqual(["the playbook must be a JSON object"]);
	});

	it("gives the same bytes for the same content, so the prompt cache keeps hitting", () => {
		expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
		const p = valid();
		const reordered = JSON.parse(JSON.stringify({ ...p, summary: p.summary, schema: p.schema })) as Playbook;
		expect(playbookPrompt(3, reordered)).toBe(playbookPrompt(3, p));
		expect(playbookPrompt(3, p)).not.toBe(playbookPrompt(4, p));
	});
});

describe("the seed accounts", () => {
	it("the example seed file is loadable, and shows each kind of account", () => {
		const path = fileURLToPath(new URL("../seed/accounts.example.json", import.meta.url));
		const seed = JSON.parse(readFileSync(path, "utf8")) as SeedFile;
		expect(seedProblems(seed)).toEqual([]);
		const rows = seedAccounts(seed, "2026-10-09T00:00:00.000Z");
		// The bank loads before the debit card that points at it.
		const ids = rows.map((r) => r.id);
		expect(ids.indexOf("dbs-bank")).toBeLessThan(ids.indexOf("dbs-debit"));
		expect(rows.find((r) => r.id === "dbs-debit")).toMatchObject({ has_statements: 0, alerts_expected: 1, settles_to: "dbs-bank" });
		// 台新 sends no email alerts.
		expect(rows.filter((r) => r.institution === "taishin").map((r) => r.alerts_expected)).toEqual([0, 0]);
		// Citi mails no PDF; the lost 台新 card keeps its old statements but is not expected any more.
		expect(rows.find((r) => r.id === "citi-card")).toMatchObject({ has_statements: 0, alerts_expected: 1, active: 1 });
		expect(rows.find((r) => r.id === "taishin-old")).toMatchObject({ has_statements: 1, active: 0 });
		expect(rows.filter((r) => r.id !== "taishin-old").every((r) => r.active === 1)).toBe(true);
		expect(rows.find((r) => r.id === "cash")).toMatchObject({ alerts_expected: 0, has_statements: 0 });
		// A prepaid card with a bonus deal and an SMS sender.
		expect(rows.find((r) => r.id === "sample-bistro")).toMatchObject({ wallet_topup_deal_paid_minor: 20000, wallet_topup_deal_credit_minor: 24000, wallet_sms_sender: "RestoSuite" });
	});

	const base = (): SeedFile => ({
		banks: [
			{ institution: "testbank", name: "Test Bank", domains: ["testbank.example"] },
			{ institution: "otherbank", name: "Other Bank", domains: ["otherbank.example", "mail.otherbank.example"] },
		],
		accounts: [
			{ id: "b", institution: "testbank", kind: "bank", name: "B", last4: "9001", currency: "SGD" },
			{ id: "d", institution: "testbank", kind: "debit_card", name: "D", last4: "9002", currency: "SGD", settles_to: "b", wallet_names: ["Test Debit"] },
			{ id: "c", institution: "otherbank", kind: "credit_card", name: "C", last4: "1111", currency: "SGD", wallet_names: ["Other Card"] },
		],
	});

	it("checks what would break the database or matching", () => {
		const s = base();
		s.accounts[1]!.settles_to = "c";
		s.accounts[2]!.last4 = "11a1";
		s.accounts.push({ id: "x", institution: "testbank", kind: "credit_card", name: "X", last4: null, currency: "SGD" });
		s.accounts.push({ id: "y", institution: "otherbank", kind: "credit_card", name: "Y", last4: "2222", currency: "SGD", wallet_names: ["OTHER  card"] });
		const problems = seedProblems(s).join("\n");
		expect(problems).toMatch(/d: a debit card must settle to a bank account/);
		expect(problems).toMatch(/c: last4 must be exactly 4 digits/);
		expect(problems).toMatch(/x: a missing last4 needs a todo/);
		expect(problems).toMatch(/y: Wallet name "OTHER {2}card" already belongs to c/);
		expect(() => seedAccounts(s, "2026-01-01T00:00:00.000Z")).toThrow(/not safe to load/);
	});

	it("checks the bank list: plain domains of the owner's own banks, and every bank or card's bank on it", () => {
		const s = base();
		s.banks.push({ institution: "badbank", name: "", domains: ["alerts@badbank.example", "gmail.com"] });
		s.banks.push({ institution: "copybank", name: "Copy", domains: ["testbank.example"], sender_names: ["two words"] });
		s.accounts.push({ id: "z", institution: "unlisted", kind: "credit_card", name: "Z", last4: "3333", currency: "SGD" });
		const problems = seedProblems(s).join("\n");
		expect(problems).toMatch(/banks\[2\]: name is empty/);
		expect(problems).toMatch(/"alerts@badbank.example" is not a plain domain/);
		expect(problems).toMatch(/gmail.com is a public mailbox provider/);
		expect(problems).toMatch(/testbank.example already belongs to testbank/);
		expect(problems).toMatch(/sender_names must be single words/);
		expect(problems).toMatch(/z: its bank "unlisted" is not in "banks"/);
		// A card at an unlisted bank that says it sends no alerts is fine (its statements come by upload).
		const ok = base();
		ok.accounts.push({ id: "z", institution: "unlisted", kind: "credit_card", name: "Z", last4: "3333", currency: "SGD", alerts_expected: false });
		expect(seedProblems(ok)).toEqual([]);
		expect(seedProblems({ accounts: base().accounts } as SeedFile)[0]).toMatch(/no "banks" list/);
	});

	it("with the home currency known, cash and wallets must be in it", () => {
		const s = base();
		s.accounts.push({ id: "cash", institution: "cash", kind: "cash", name: "Cash", last4: null, currency: "USD" });
		expect(seedProblems(s)).toEqual([]); // home not known: not checked
		expect(seedProblems(s, { homeCurrency: "SGD" }).join("\n")).toMatch(/cash: cash and wallets are kept in your home currency \(SGD\)/);
		expect(seedProblems(s, { homeCurrency: "USD" })).toEqual([]);
	});

	it("writes the bank list into the database, replacing the one there (a domain removed stops being trusted)", () => {
		const db = freshDb();
		db.raw.exec(seedSql(base()));
		const stored = () => JSON.parse((db.raw.prepare("SELECT value FROM sync_state WHERE key = 'banks'").get() as { value: string }).value);
		expect(stored()).toEqual([
			{ institution: "testbank", name: "Test Bank", domains: ["testbank.example"] },
			{ institution: "otherbank", name: "Other Bank", domains: ["otherbank.example", "mail.otherbank.example"] },
		]);
		const fewer = base();
		fewer.banks = fewer.banks.slice(0, 1);
		fewer.accounts = fewer.accounts.slice(0, 2);
		db.raw.exec(seedSql(fewer));
		expect(stored()).toEqual([{ institution: "testbank", name: "Test Bank", domains: ["testbank.example"] }]);
		db.close();
	});

	it("maps Wallet names to accounts", () => {
		expect(walletRows(base())).toEqual([
			{ wallet_key: "TEST DEBIT", account_id: "d" },
			{ wallet_key: "OTHER CARD", account_id: "c" },
		]);
	});
});
