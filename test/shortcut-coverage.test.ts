import { makeHome, setHome, SINGAPORE } from "../src/home";
import { describe, expect, it } from "vitest";
import { accountCoverage } from "../src/coverage";
import { matchEvidence, type Candidate, type MatchInput } from "../src/matching";
import { accountForWallet, parseTap, parseTapAmount, shortcutAuthorised, walletKey } from "../src/shortcut";
import type { EvidenceType, LineRow } from "../src/types";
import { BANK, CARD_A, CARD_T, CASH, DEBIT, line } from "./helpers/fixtures";

describe("the Apple Pay shortcut's request", () => {
	const tap = { card: "Test Bank Rewards", merchant: "Kopi Corner", amount: "S$4.50", timestamp: "2026-03-05T08:15:00+08:00" };

	it("reads a normal tap into Singapore date and time", () => {
		expect(parseTap(tap)).toMatchObject({
			wallet_key: "TEST BANK REWARDS",
			currency: "SGD",
			amount_minor: 450,
			merchant_raw: "Kopi Corner",
			txn_date: "2026-03-05",
			txn_time: "08:15",
		});
	});

	it("dates a tap abroad by the Singapore calendar", () => {
		// 23:30 in Los Angeles on the 4th (UTC−8) is 15:30 on the 5th in Singapore.
		expect(parseTap({ ...tap, amount: "US$20.00", timestamp: "2026-03-04T23:30:00-08:00" })).toMatchObject({ currency: "USD", amount_minor: 2000, txn_date: "2026-03-05", txn_time: "15:30" });
	});

	it("reads the amount formats Wallet prints", () => {
		expect(parseTapAmount("¥1,200", undefined)).toEqual({ currency: "JPY", minor: 1200 });
		expect(parseTapAmount("JPY 1,200.00", undefined)).toEqual({ currency: "JPY", minor: 1200 });
		expect(parseTapAmount("NT$350", undefined)).toEqual({ currency: "TWD", minor: 35000 });
		expect(parseTapAmount("1.234,56", "EUR")).toEqual({ currency: "EUR", minor: 123456 });
		expect(parseTapAmount("12,50", "EUR")).toEqual({ currency: "EUR", minor: 1250 });
		expect(parseTapAmount("1,200", "SGD")).toEqual({ currency: "SGD", minor: 120000 }); // thousands, not 1.2
		expect(parseTapAmount("4.50", "SGD")).toEqual({ currency: "SGD", minor: 450 });
	});

	it("refuses what it cannot be sure of", () => {
		// A bare "$" is the home dollar (how an iPhone prints its own currency); at a
		// home whose currency is not a dollar it could be any dollar: refused.
		expect(parseTapAmount("$4.50", undefined)).toEqual({ currency: "SGD", minor: 450 });
		setHome(makeHome("EUR", "Europe/Paris", "FR"));
		expect(parseTapAmount("$4.50", undefined)).toMatch(/currency/);
		setHome(SINGAPORE);
		expect(parseTapAmount("S$4.50", "USD")).toMatch(/says SGD/);
		expect(parseTapAmount("S$0.00", undefined)).toMatch(/more than zero/);
		expect(parseTap({ ...tap, timestamp: "2026-03-05 08:15" })).toMatch(/time zone/);
		expect(parseTap({ ...tap, card: " " })).toMatch(/card/);
		expect(parseTap(null)).toMatch(/JSON object/);
	});

	it("gives a double-fired shortcut the same fingerprint", () => {
		const a = parseTap(tap);
		const b = parseTap({ ...tap, card: "test bank  rewards", timestamp: "2026-03-05T00:15:40Z" });
		expect(typeof a !== "string" && typeof b !== "string" && a.fingerprint === b.fingerprint).toBe(true);
	});

	it("finds the account by Wallet name, loosely, and never guesses", () => {
		const names = new Map([[walletKey("Test Bank Rewards"), CARD_A.id]]);
		expect(accountForWallet(walletKey("TEST BANK - rewards"), names)).toBe(CARD_A.id);
		expect(accountForWallet(walletKey("Some Other Card"), names)).toBeNull();
	});

	it("opens only for the exact key", async () => {
		const secret = "k".repeat(40);
		expect(await shortcutAuthorised(`Bearer ${secret}`, secret)).toBe(true);
		expect(await shortcutAuthorised(`Bearer ${secret}x`, secret)).toBe(false);
		expect(await shortcutAuthorised(secret, secret)).toBe(false); // no "Bearer"
		expect(await shortcutAuthorised(null, secret)).toBe(false);
		expect(await shortcutAuthorised("Bearer short", "short")).toBe(false); // a secret under 32 characters is refused
		expect(await shortcutAuthorised("Bearer x", undefined)).toBe(false);
	});
});

describe("alert + Apple Pay tap + statement line become ONE line", () => {
	const cand = (l: LineRow, has: EvidenceType[]): Candidate => ({ line: l, has: new Set(has) });
	const ev = (type: EvidenceType, over: Partial<MatchInput> = {}): MatchInput => ({
		type,
		account_ids: new Set([CARD_A.id]),
		kind: "purchase",
		currency: "SGD",
		amount_minor: 450,
		txn_date: "2026-03-05",
		merchant_key: "KOPI CORNER",
		...over,
	});

	it("the tap starts the line; the alert and the statement attach to it", () => {
		expect(matchEvidence(ev("apple_pay_shortcut"), [])).toEqual({ action: "create" });
		const L = line({ id: "L", merchant_key: "KOPI CORNER", orig_minor: 450, bill_minor: 450 });
		expect(matchEvidence(ev("alert"), [cand(L, ["apple_pay_shortcut"])])).toMatchObject({ action: "attach", line_id: "L" });
		expect(matchEvidence(ev("statement_line", { txn_date: "2026-03-06" }), [cand(L, ["apple_pay_shortcut", "alert"])])).toMatchObject({ action: "attach", line_id: "L" });
	});

	it("in the other order too: alert first, then the tap", () => {
		const L = line({ id: "L", merchant_key: "KOPI CORNER", orig_minor: 450, bill_minor: 450 });
		expect(matchEvidence(ev("apple_pay_shortcut"), [cand(L, ["alert"])])).toMatchObject({ action: "attach", line_id: "L" });
	});

	it("a second tap of the same price is a second purchase", () => {
		const L = line({ id: "L", merchant_key: "KOPI CORNER", orig_minor: 450, bill_minor: 450 });
		expect(matchEvidence(ev("apple_pay_shortcut"), [cand(L, ["apple_pay_shortcut", "alert"])])).toEqual({ action: "create" });
	});
});

describe("coverage: never imply zero spending where the ledger has not been told", () => {
	const statements = [
		{ account_id: CARD_T.id, period_end: "2026-02-25" },
		{ account_id: CARD_T.id, period_end: "2026-03-25" },
		{ account_id: BANK.id, period_end: "2026-03-31" },
	];
	const taishin = { ...CARD_T, name: "Taishin card", alerts_expected: 0 as const };

	it("a card with email alerts is up to date", () => {
		expect(accountCoverage(CARD_A, statements, null, "2026-04-10")).toMatchObject({ mode: "live", partial: false, message: `${CARD_A.name}: up to date` });
	});

	it("a card without email alerts is complete only to its last statement", () => {
		// Between two statements: partial (the newest spending is not known yet — never zero), but NOT late.
		expect(accountCoverage(taishin, statements, null, "2026-04-10")).toMatchObject({
			mode: "statement_only",
			complete_through: "2026-03-25",
			partial: true,
			next_statement_due: "2026-04-25", // 2026-03-25 + one month
			overdue: false,
			overdue_reason: null,
			message: "Taishin card: up to date as of the statement of 2026-03-25; spending after it comes with the next statement (closing about 2026-04-25) — not yet known, not zero",
		});
		expect(accountCoverage(taishin, statements, "2026-04-02", "2026-04-10").message).toBe(
			"Taishin card: up to date as of the statement of 2026-03-25; after that, only Apple Pay taps; spending after it comes with the next statement (closing about 2026-04-25) — not yet known, not zero",
		);
		expect(accountCoverage(taishin, statements, null, "2026-03-25")).toMatchObject({ partial: false, overdue: false });
	});

	it("is late only 10 days after the next statement should have closed — on the card's cut-off day when set", () => {
		// Due 2026-04-25; late from 2026-05-06 (2026-04-25 + 10 = 2026-05-05 is still on time).
		expect(accountCoverage(taishin, statements, null, "2026-05-05").overdue).toBe(false);
		const late = accountCoverage(taishin, statements, null, "2026-05-06");
		expect(late).toMatchObject({ partial: true, overdue: true, next_statement_due: "2026-04-25", overdue_reason: null });
		expect(late.message).toBe("Taishin card: up to date as of the statement of 2026-03-25. The next statement (closing about 2026-04-25) is late: the ledger has not received it.");
		// A cut-off day of the 13th (round 2): due 2026-04-13, late from 2026-04-24.
		const cut13 = { ...taishin, statement_day: 13 };
		expect(accountCoverage(cut13, statements, null, "2026-04-23")).toMatchObject({ next_statement_due: "2026-04-13", overdue: false });
		expect(accountCoverage(cut13, statements, null, "2026-04-24").overdue).toBe(true);
		// The 31st in a 30-day month closes on the 30th.
		expect(accountCoverage({ ...taishin, statement_day: 31 }, statements, null, "2026-04-10").next_statement_due).toBe("2026-04-30");
	});

	it("says why it is late when the ledger knows", () => {
		const r = accountCoverage(taishin, statements, null, "2026-05-20", [], null, { kind: "pdf_password", since: "2026-04-28" });
		expect(r).toMatchObject({ overdue: true, overdue_reason: { kind: "pdf_password", since: "2026-04-28" } });
		expect(r.message).toContain("its PDF would not open");
		expect(accountCoverage(taishin, statements, null, "2026-05-20", [], null, { kind: "no_mail", since: "2026-03-28" }).message).toContain("no statement email from the bank has arrived since 2026-03-28");
		// A reason is never carried while the statement is not late.
		expect(accountCoverage(taishin, statements, null, "2026-04-10", [], null, { kind: "pdf_password", since: null }).overdue_reason).toBeNull();
	});

	it("before any statement, says so", () => {
		expect(accountCoverage(taishin, [], null, "2026-04-10").message).toBe("Taishin card: no statement yet — nothing recorded so far");
		expect(accountCoverage(taishin, [], "2026-04-01", "2026-04-10").message).toBe("Taishin card: no statement yet — only Apple Pay taps so far");
	});

	it("reads a debit card's statements from its bank, and cash from nobody", () => {
		expect(accountCoverage({ ...DEBIT, alerts_expected: 0 }, statements, null, "2026-04-10").complete_through).toBe("2026-03-31");
		expect(accountCoverage(CASH, statements, null, "2026-04-10")).toMatchObject({ mode: "manual", partial: false });
	});
});
