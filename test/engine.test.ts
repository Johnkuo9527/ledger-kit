/// End to end, on a real in-memory SQLite database with the real migration:
/// evidence in, ledger lines out. Every account, merchant and amount here is
/// MADE UP; every expected figure was worked out by hand in the comments first.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountCoverage } from "../src/coverage";
import { addCash, correctHome, getLine, ingestEvidence, ingestStatement, ingestTap, setReimbursable, addReimburseRange, type Engine, type EvidenceIn } from "../src/engine";
import { reimbursableTotal } from "../src/reimbursable";
import { ACCOUNT_INSERT, accountValues } from "../src/seed";
import { walletKey } from "../src/shortcut";
import type { Account, EvidenceType, LineRow, Statement } from "../src/types";
import { lineView, monthView, totals } from "../src/views";
import { ACCOUNTS, BANK, CARD_A, CARD_B, CARD_C, CARD_T, DEBIT } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";

const RATES: [string, string, number][] = [
	["2026-03-10", "USD", 1.35],
	["2026-03-13", "USD", 1.34],
	["2026-04-02", "USD", 1.36],
	["2026-03-10", "JPY", 0.009],
	["2026-03-10", "TWD", 0.042],
	["2026-03-17", "TWD", 0.042],
	["2026-03-20", "TWD", 0.042],
];

let db: TestDb;
let e: Engine;

async function setup(accounts: readonly Account[] = ACCOUNTS): Promise<void> {
	db = freshDb();
	for (const a of accounts) await db.prepare(ACCOUNT_INSERT).bind(...accountValues(a)).run();
	for (const [name, id] of [
		["Test Rewards", CARD_A.id],
		["Test Taishin", CARD_T.id],
	] as const) {
		await db.prepare("INSERT INTO account_wallet_names (wallet_key, account_id) VALUES (?, ?)").bind(walletKey(name), id).run();
	}
	for (const [date, ccy, rate] of RATES) {
		await db.prepare("INSERT INTO fx_rates (date, currency, quote, rate, source) VALUES (?, ?, 'SGD', ?, 'test')").bind(date, ccy, rate).run();
	}
	let tick = 0;
	let ids = 0;
	e = {
		db,
		now: () => new Date(Date.UTC(2026, 9, 9, 0, 0, 0, tick++)).toISOString(),
		newId: () => `id-${String(++ids).padStart(4, "0")}`,
		ownNames: ["ALEX DOE"],
		aliases: [],
		actor: "rules",
	};
}

const TAISHIN_NO_EMAIL: Account = { ...CARD_T, alerts_expected: 0 };
beforeEach(() => setup(ACCOUNTS.map((a) => (a.id === CARD_T.id ? TAISHIN_NO_EMAIL : a))));
afterEach(() => db.close());

const alert = (over: Partial<EvidenceIn> & Pick<EvidenceIn, "fingerprint">): EvidenceIn => ({
	type: "alert",
	institution: "hsbc",
	last4: "1111",
	txn_date: "2026-03-10",
	currency: "SGD",
	amount_minor: 1000,
	merchant_raw: "TEST",
	kind_hint: "purchase",
	...over,
});

async function typesOf(lineId: string): Promise<EvidenceType[]> {
	const rows = (await db.prepare("SELECT type FROM evidence WHERE line_id = ? ORDER BY type").bind(lineId).all<{ type: EvidenceType }>()).results;
	return rows.map((r) => r.type);
}
async function all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
	return (await db.prepare(sql).bind(...args).all<T>()).results;
}
async function line(id: string): Promise<LineRow> {
	return (await getLine(db, id))!;
}

describe("The owner's FX rule, start to finish, with a tap, an alert and a statement for ONE purchase", () => {
	it("estimates, confirms on the statement, learns the markup, and re-estimates what is still open", async () => {
		// 1. The Apple Pay tap arrives first. USD 100.00 × 1.35 × (1 + 3.25% HSBC default) = SGD 139.3875 → 13939.
		const tap = await ingestTap(e, { card: "Test Rewards", merchant: "Blue Bottle", amount: "US$100.00", timestamp: "2026-03-10T12:00:00+08:00" });
		expect(tap.status).toBe("created");
		const L = (tap as { line_id: string }).line_id;
		expect(await line(L)).toMatchObject({ orig_currency: "USD", orig_minor: 10000, bill_minor: 13939, bill_status: "estimate", markup_source: "bank_default", home_minor: 13939, home_status: "estimate", state: "open" });

		// 2. The bank's alert for the same purchase joins the same line; a re-sent copy is ignored.
		const a1 = alert({ fingerprint: "a1", currency: "USD", amount_minor: 10000, merchant_raw: "BLUE BOTTLE COFFEE SAN FRANCISCO US" });
		expect(await ingestEvidence(e, a1)).toMatchObject({ status: "attached", line_id: L });
		expect(await ingestEvidence(e, a1)).toEqual({ status: "duplicate" });

		// 3. Another USD purchase on the Saturday; the rate is Friday's 1.34. 20 × 1.34 × 1.0325 = 27.671 → 2767.
		const r2 = await ingestEvidence(e, alert({ fingerprint: "a2", txn_date: "2026-03-14", currency: "USD", amount_minor: 2000, merchant_raw: "SHOP USA" }));
		const L2 = (r2 as { line_id: string }).line_id;
		expect(await line(L2)).toMatchObject({ bill_minor: 2767, market_rate: 1.34 });

		// 4. The statement. Billed SGD 137.70 + an itemised fee of 1.38 + an un-alerted coffee 4.50 − a payment 50.00.
		//    Net 13770 + 138 + 450 − 5000 = 9358 = closing 14358 − opening 5000. ✓
		const s1 = await ingestStatement(
			e,
			{ account_id: CARD_A.id, period_start: "2026-02-16", period_end: "2026-03-15", currency: "SGD", opening_balance_minor: 5000, closing_balance_minor: 14358, printed_net_minor: null },
			[
				{ seq: 1, txn_date: "2026-03-10", currency: "USD", amount_minor: 10000, bill_currency: "SGD", bill_minor: 13770, merchant_raw: "BLUE BOTTLE COFFEE SAN FRANCISCO US", merchant_country: "US", kind_hint: "purchase" },
				{ seq: 2, txn_date: "2026-03-10", currency: "SGD", amount_minor: 138, merchant_raw: "FOREIGN TRANSACTION FEE", kind_hint: "fx_fee" },
				{ seq: 3, txn_date: "2026-03-12", currency: "SGD", amount_minor: 450, merchant_raw: "KOPI CORNER", kind_hint: "purchase" },
				{ seq: 4, txn_date: "2026-03-01", currency: "SGD", amount_minor: -5000, merchant_raw: "PAYMENT - THANK YOU", kind_hint: "payment" },
			],
		);
		expect(s1.status).toBe("imported");
		if (s1.status !== "imported") return;
		expect(s1.recon).toMatchObject({ ok: true, expected_minor: 9358, ledger_minor: 9358, difference_minor: 0 });

		// ONE line carries the tap, the alert and the statement line (and the fee line).
		expect(await typesOf(L)).toEqual(["alert", "apple_pay_shortcut", "statement_line", "statement_line"]);
		// Billed 137.70 + fee 1.38 = 139.08. Effective 1.3908; 1.3908 ÷ 1.35 − 1 = 0.0302222…
		const confirmed = await line(L);
		expect(confirmed).toMatchObject({ bill_minor: 13908, fee_minor: 138, bill_status: "confirmed", home_minor: 13908, home_status: "confirmed", state: "reconciled", merchant_country: "US" });
		expect(confirmed.effective_rate).toBeCloseTo(1.3908, 10);
		expect(confirmed.observed_markup).toBeCloseTo(0.0302222222, 9);
		const [learned] = await all<{ markup: number; observed_txn_date: string }>("SELECT markup, observed_txn_date FROM card_fx_markups WHERE account_id = ? AND currency = 'USD'", CARD_A.id);
		expect(learned!.markup).toBeCloseTo(0.0302222222, 9);
		expect(learned!.observed_txn_date).toBe("2026-03-10");

		// The open Saturday estimate is redone with what the card just taught: 20 × 1.34 × 1.0302222 = 27.60996 → 2761.
		expect(await line(L2)).toMatchObject({ bill_minor: 2761, markup_source: "learned", bill_status: "estimate", flag_not_on_statement: 0 });

		// The coffee no alert told us about, and the payment that is never spending.
		const [kopi] = await all<LineRow>("SELECT * FROM lines WHERE merchant_key = 'KOPI CORNER'");
		expect(kopi).toMatchObject({ flag_missed_by_alerts: 1, state: "reconciled" });
		const [pay] = await all<LineRow>("SELECT * FROM lines WHERE kind = 'card_payment'");
		expect(pay).toMatchObject({ bill_minor: -5000, state: "reconciled" });

		// 5. Next purchase uses the learned markup: 50 × 1.36 × 1.0302222 = 70.05511 → 7006.
		const r3 = await ingestEvidence(e, alert({ fingerprint: "a3", txn_date: "2026-04-02", currency: "USD", amount_minor: 5000, merchant_raw: "SHOP USA" }));
		const L3 = (r3 as { line_id: string }).line_id;
		expect(await line(L3)).toMatchObject({ bill_minor: 7006, markup_source: "learned" });

		// 6. The next statement does not carry the Saturday purchase: still an estimate, now flagged.
		const s2 = await ingestStatement(
			e,
			{ account_id: CARD_A.id, period_start: "2026-03-16", period_end: "2026-04-15", currency: "SGD", opening_balance_minor: 14358, closing_balance_minor: 21368, printed_net_minor: 7010 },
			[{ seq: 1, txn_date: "2026-04-02", currency: "USD", amount_minor: 5000, bill_currency: "SGD", bill_minor: 7010, merchant_raw: "SHOP USA", kind_hint: "purchase" }],
		);
		expect(s2.status === "imported" && s2.recon.ok).toBe(true);
		expect(await line(L2)).toMatchObject({ bill_status: "estimate", flag_not_on_statement: 1 });
		// 70.10 ÷ 50 = 1.402; 1.402 ÷ 1.36 − 1 = 0.0308824 — the newer observation wins.
		const [relearned] = await all<{ markup: number }>("SELECT markup FROM card_fx_markups WHERE account_id = ?", CARD_A.id);
		expect(relearned!.markup).toBeCloseTo(0.0308823529, 9);
		// …and the still-open Saturday estimate is redone again: 20 × 1.34 × 1.0308824 = 27.62765 → 2763.
		expect(await line(L2)).toMatchObject({ bill_minor: 2763, markup: expect.closeTo(0.0308823529, 9) });

		// What the page and the connector read.
		const view = lineView(confirmed, CARD_A, new Set(await typesOf(L)), [], null);
		expect(view).toMatchObject({
			provisional: false,
			spending: true,
			evidence: ["alert", "apple_pay_shortcut", "statement_line"], // the KINDS of proof; the fee line adds none
			amount: { original: { display: "USD 100.00" }, home: { minor: 13908, status: "confirmed", display: "SGD 139.08" }, overseas_fee: { minor: 138 } },
			fx: { markup_source: "bank_default" },
			flags: [],
		});
		const open = lineView(await line(L2), CARD_A, new Set(await typesOf(L2)), [], null);
		expect(open).toMatchObject({ provisional: true, flags: ["not_on_statement"] });
		// Spending: 139.08 + 4.50 + 27.63 + 70.10 = 241.31; unconfirmed: the Saturday 27.63.
		expect(totals(await all<LineRow>("SELECT * FROM lines"))).toMatchObject({ spending_home: { minor: 24131 }, count: 4, unconfirmed_home: { minor: 2763 } });

		// Every change left a trail — and a step that changed nothing (its flags) left none.
		const events = await all<{ event: string }>("SELECT event FROM line_events WHERE line_id = ? ORDER BY id", L);
		expect(events.map((x) => x.event)).toEqual(["create", "evidence", "attach_statement", "attach_fee", "confirm_fx", "reconcile"]);
	});
});

describe("one purchase, one line — the everyday cases", () => {
	it("two identical coffees stay two, and pair with two identical statement lines", async () => {
		const coffee = (fp: string, time: string) => alert({ fingerprint: fp, institution: "hsbc", last4: "2222", txn_date: "2026-03-05", txn_time: time, amount_minor: 450, merchant_raw: "KOPI CORNER" });
		const c1 = await ingestEvidence(e, coffee("b1", "08:15"));
		const c2 = await ingestEvidence(e, coffee("b2", "08:16"));
		expect([c1.status, c2.status]).toEqual(["created", "created"]);
		const s = await ingestStatement(e, { account_id: CARD_B.id, period_start: "2026-02-16", period_end: "2026-03-15", currency: "SGD", opening_balance_minor: 0, closing_balance_minor: 900, printed_net_minor: null }, [
			{ seq: 1, txn_date: "2026-03-05", currency: "SGD", amount_minor: 450, merchant_raw: "KOPI CORNER", kind_hint: "purchase" },
			{ seq: 2, txn_date: "2026-03-05", currency: "SGD", amount_minor: 450, merchant_raw: "KOPI CORNER", kind_hint: "purchase" },
		]);
		expect(s.status === "imported" && s.recon.ok && s.created.length === 0 && s.attached.length === 2).toBe(true);
		for (const r of [c1, c2]) expect(await typesOf((r as { line_id: string }).line_id)).toEqual(["alert", "statement_line"]);
	});

	it("a receipt that arrives before the payment waits, then joins it", async () => {
		const receipt: EvidenceIn = { type: "receipt", fingerprint: "receipt|bookshop.example|A-1", txn_date: "2026-03-06", currency: "SGD", amount_minor: 2590, merchant_raw: "Bookshop" };
		expect(await ingestEvidence(e, receipt)).toMatchObject({ status: "held" });
		const paid = await ingestEvidence(e, alert({ fingerprint: "b3", institution: "citi", last4: "3333", txn_date: "2026-03-06", amount_minor: 2590, merchant_raw: "BOOKSHOP PTE LTD" }));
		expect(await typesOf((paid as { line_id: string }).line_id)).toEqual(["alert", "receipt"]);
		expect(await all("SELECT * FROM lines")).toHaveLength(1);
	});

	it("an alert for a card nobody can identify is held, never guessed", async () => {
		expect(await ingestEvidence(e, alert({ fingerprint: "x", institution: "hsbc", last4: "9999" }))).toMatchObject({ status: "held" });
		expect(await all("SELECT kind FROM escalations")).toEqual([{ kind: "unknown_account" }]);
		expect(await all("SELECT * FROM lines")).toHaveLength(0);
	});

	it("a tap from a Wallet card not on the list is held and asked about", async () => {
		const r = await ingestTap(e, { card: "Mystery Card", merchant: "Shop", amount: "S$5.00", timestamp: "2026-03-05T10:00:00+08:00" });
		expect(r).toMatchObject({ status: "held" });
		expect(await all("SELECT kind FROM escalations")).toEqual([{ kind: "unknown_wallet_card" }]);
		expect(await ingestTap(e, { card: "Mystery Card", merchant: "Shop", amount: "S$5.00", timestamp: "2026-03-05T10:00:00+08:00" })).toEqual({ status: "duplicate" });
		expect(await ingestTap(e, { card: "x" })).toMatchObject({ status: "refused" });
	});
});

describe("refunds, card bills and the DBS account", () => {
	it("links a refund, pairs a card bill's two legs, and reconciles the bank with its debit card", async () => {
		const zara = await ingestEvidence(e, alert({ fingerprint: "c1", txn_date: "2026-05-01", amount_minor: 8000, merchant_raw: "ZARA ION" }));
		const back = await ingestEvidence(e, alert({ fingerprint: "c2", txn_date: "2026-05-04", amount_minor: -3000, merchant_raw: "ZARA ION", kind_hint: "refund" }));
		const stray = await ingestEvidence(e, alert({ fingerprint: "c2b", txn_date: "2026-05-04", amount_minor: -1000, merchant_raw: "SHOP NOBODY KNOWS", kind_hint: "refund" }));
		const Z = (zara as { line_id: string }).line_id;
		expect(await line((back as { line_id: string }).line_id)).toMatchObject({ kind: "refund", refund_of: Z, flag_unlinked_refund: 0 });
		expect(await line((stray as { line_id: string }).line_id)).toMatchObject({ refund_of: null, flag_unlinked_refund: 1 });

		// The DBS side: a debit-card purchase, PayNow in from a friend, and the HSBC bill.
		const ntuc = await ingestEvidence(e, alert({ fingerprint: "d1", institution: "dbs", last4: DEBIT.last4, txn_date: "2026-05-03", amount_minor: 4520, merchant_raw: "NTUC FAIRPRICE" }));
		expect(await line((ntuc as { line_id: string }).line_id)).toMatchObject({ account_id: DEBIT.id });
		await ingestEvidence(e, alert({ fingerprint: "d2", institution: "dbs", last4: BANK.last4, txn_date: "2026-05-06", amount_minor: -8000, merchant_raw: "PAYNOW FROM ALICE TAN", kind_hint: "transfer" }));
		const bill = await ingestEvidence(e, alert({ fingerprint: "d3", institution: "dbs", last4: BANK.last4, txn_date: "2026-05-10", amount_minor: 50000, merchant_raw: "BILL PAYMENT TO HSBC CARD 1111", kind_hint: "payment" }));
		const billLine = await line((bill as { line_id: string }).line_id);
		expect(billLine.kind).toBe("card_payment");

		// The HSBC statement: 80.00 − 30.00 − 10.00 − 500.00 = −460.00; closing 600.00 − 460.00 = 140.00.
		const card = await ingestStatement(e, { account_id: CARD_A.id, period_start: "2026-04-16", period_end: "2026-05-15", currency: "SGD", opening_balance_minor: 60000, closing_balance_minor: 14000, printed_net_minor: null }, [
			{ seq: 1, txn_date: "2026-05-01", currency: "SGD", amount_minor: 8000, merchant_raw: "ZARA ION", kind_hint: "purchase" },
			{ seq: 2, txn_date: "2026-05-04", currency: "SGD", amount_minor: -3000, merchant_raw: "ZARA ION", kind_hint: "refund" },
			{ seq: 3, txn_date: "2026-05-04", currency: "SGD", amount_minor: -1000, merchant_raw: "SHOP NOBODY KNOWS", kind_hint: "refund" },
			{ seq: 4, txn_date: "2026-05-11", currency: "SGD", amount_minor: -50000, merchant_raw: "PAYMENT RECEIVED", kind_hint: "payment" },
		]);
		expect(card.status === "imported" && card.recon.ok).toBe(true);
		const [cardLeg] = await all<LineRow>("SELECT * FROM lines WHERE account_id = ? AND kind = 'card_payment'", CARD_A.id);
		expect(cardLeg!.transfer_group).not.toBeNull();
		expect((await line(billLine.id)).transfer_group).toBe(cardLeg!.transfer_group);

		// The DBS statement: 45.20 − 80.00 + 500.00 + an ATM 200.00 = 665.20; 5,000.00 − 665.20 = 4,334.80.
		const bank = await ingestStatement(e, { account_id: BANK.id, period_start: "2026-05-01", period_end: "2026-05-31", currency: "SGD", opening_balance_minor: 500000, closing_balance_minor: 433480, printed_net_minor: null }, [
			{ seq: 1, txn_date: "2026-05-03", currency: "SGD", amount_minor: 4520, merchant_raw: "NTUC FAIRPRICE", kind_hint: "purchase" },
			{ seq: 2, txn_date: "2026-05-06", currency: "SGD", amount_minor: -8000, merchant_raw: "PAYNOW FROM ALICE TAN", kind_hint: "transfer" },
			{ seq: 3, txn_date: "2026-05-10", currency: "SGD", amount_minor: 50000, merchant_raw: "BILL PAYMENT TO HSBC CARD 1111", kind_hint: "payment" },
			{ seq: 4, txn_date: "2026-05-20", currency: "SGD", amount_minor: 20000, merchant_raw: "ATM WITHDRAWAL", kind_hint: "atm" },
		]);
		expect(bank.status === "imported" && bank.recon).toMatchObject({ ok: true, rule: "bank_balance", expected_minor: 66520 });
		const [atm] = await all<LineRow>("SELECT * FROM lines WHERE merchant_raw = 'ATM WITHDRAWAL'");
		expect(atm).toMatchObject({ kind: "transfer", flag_missed_by_alerts: 1, state: "reconciled" });

		// Spending is 80.00 − 30.00 − 10.00 + 45.20 = 85.20. The card bill, the ATM and the PayNow in are not spending.
		expect(totals(await all<LineRow>("SELECT * FROM lines")).spending_home.minor).toBe(8520);
	});

	it("learns the DBS debit card's number from its first AUTHENTICATED card alert, and only then", async () => {
		await setup(ACCOUNTS.map((a) => (a.id === DEBIT.id ? { ...a, last4: null } : a)));
		// A transfer alert naming another number teaches nothing.
		expect(await ingestEvidence(e, alert({ fingerprint: "t", institution: "dbs", last4: "5555", kind_hint: "transfer", amount_minor: 100 }))).toMatchObject({ status: "held" });
		// An alert Gmail did not vouch for (anyone can email the owner) teaches nothing.
		expect(await ingestEvidence(e, alert({ fingerprint: "spoof", institution: "dbs", last4: "6666", merchant_raw: "SPOOF", amount_minor: 1 }))).toMatchObject({ status: "held" });
		expect(await all("SELECT last4 FROM accounts WHERE id = ?", DEBIT.id)).toEqual([{ last4: null }]);
		const first = await ingestEvidence(e, alert({ fingerprint: "l1", institution: "dbs", last4: "7777", merchant_raw: "NTUC FAIRPRICE", amount_minor: 1234, authenticated: true }));
		expect(await line((first as { line_id: string }).line_id)).toMatchObject({ account_id: DEBIT.id });
		expect(await all("SELECT last4 FROM accounts WHERE id = ?", DEBIT.id)).toEqual([{ last4: "7777" }]);
		expect(await all("SELECT kind, status FROM escalations WHERE kind = 'learned_card_number'")).toEqual([{ kind: "learned_card_number", status: "resolved" }]);
		// No unnumbered card is left, so a new number is held, not pinned on anything.
		expect(await ingestEvidence(e, alert({ fingerprint: "l2", institution: "dbs", last4: "8888", amount_minor: 99, authenticated: true }))).toMatchObject({ status: "held" });
	});
});

describe("台新, cash, and lines only the owner can confirm", () => {
	it("records a Taishin statement in TWD, with SGD at the reference rate and no 'missed by alerts'", async () => {
		// NT$350.00 + NT$660.00 for a USD 20.00 charge = 101000.
		const s = await ingestStatement(e, { account_id: CARD_T.id, period_start: "2026-02-21", period_end: "2026-03-20", currency: "TWD", opening_balance_minor: 0, closing_balance_minor: 101000, printed_net_minor: null }, [
			{ seq: 1, txn_date: "2026-03-18", currency: "TWD", amount_minor: 35000, merchant_raw: "全家便利商店 台北市", merchant_country: "TW", kind_hint: "purchase" },
			{ seq: 2, txn_date: "2026-03-10", currency: "USD", amount_minor: 2000, bill_currency: "TWD", bill_minor: 66000, merchant_raw: "APP STORE", merchant_country: "US", kind_hint: "purchase" },
		]);
		expect(s.status === "imported" && s.recon.ok).toBe(true);
		const [fami] = await all<LineRow>("SELECT * FROM lines WHERE orig_currency = 'TWD'");
		// NT$350.00 × 0.042 = SGD 14.70.
		expect(fami).toMatchObject({ bill_minor: 35000, home_minor: 1470, home_status: "reference", flag_missed_by_alerts: 0 });
		const [app] = await all<LineRow>("SELECT * FROM lines WHERE orig_currency = 'USD'");
		// USD→TWD = 1.35 ÷ 0.042 = 32.142857; billed 660 ÷ 20 = 33.0; 33.0 ÷ 32.142857 − 1 = 0.0266667. SGD: 660 × 0.042 = 27.72.
		expect(app).toMatchObject({ bill_status: "confirmed", home_minor: 2772, home_status: "reference" });
		expect(app!.observed_markup).toBeCloseTo(0.0266666667, 9);

		// After the statement, only Apple Pay taps can tell us anything: NT$120 × 0.042 = SGD 5.04.
		const tap = await ingestTap(e, { card: "Test Taishin", merchant: "Bakery", amount: "NT$120", timestamp: "2026-03-25T19:00:00+08:00" });
		const tapLine = await line((tap as { line_id: string }).line_id);
		expect(tapLine).toMatchObject({ account_id: CARD_T.id, bill_minor: 12000, home_minor: 504, home_status: "reference" });
		expect(lineView(tapLine, TAISHIN_NO_EMAIL, new Set(["apple_pay_shortcut"]), [], null).provisional).toBe(true);
		const statements = await all<Statement>("SELECT * FROM statements");
		expect(accountCoverage({ ...TAISHIN_NO_EMAIL, name: "Taishin card" }, statements, "2026-03-25", "2026-04-01").message).toBe(
			"Taishin card: up to date as of the statement of 2026-03-20; after that, only Apple Pay taps; spending after it comes with the next statement (closing about 2026-04-20) — not yet known, not zero",
		);
	});

	it("keeps foreign cash an estimate until the owner corrects it — and only cash or reference lines", async () => {
		// JPY 1,200 × 0.009 = SGD 10.80.
		const cash = await addCash(e, { txn_date: "2026-03-10", currency: "JPY", amount_minor: 1200, merchant: "Ramen stall" });
		expect(cash).toMatchObject({ bill_currency: "JPY", bill_minor: 1200, bill_status: "exact", home_minor: 1080, home_status: "reference", created_by: "owner" });
		expect(await correctHome(e, cash.id, 1100)).toMatchObject({ home_minor: 1100, home_status: "confirmed", home_set_by: "owner" });
		const known = await addCash(e, { txn_date: "2026-03-10", currency: "JPY", amount_minor: 500, merchant: "Vending", home_minor: 460 });
		expect(known).toMatchObject({ home_minor: 460, home_status: "confirmed", home_set_by: "owner" });

		const card = await ingestEvidence(e, alert({ fingerprint: "u", currency: "USD", amount_minor: 1000 }));
		await expect(correctHome(e, (card as { line_id: string }).line_id, 1)).rejects.toThrow(/statement confirms it/);
	});

	it("never invents a rate: a currency with none goes to review, flagged", async () => {
		const r = await ingestEvidence(e, alert({ fingerprint: "chf", currency: "CHF", amount_minor: 5000 }));
		expect(await line((r as { line_id: string }).line_id)).toMatchObject({ state: "review", flag_no_rate: 1, bill_minor: 0, home_minor: 0 });
		expect(totals(await all<LineRow>("SELECT * FROM lines")).missing_rate_count).toBe(1);
	});

	it("marks spending reimbursable by range, with the owner's per-line word winning", async () => {
		const a = await ingestEvidence(e, alert({ fingerprint: "r1", txn_date: "2026-04-11", amount_minor: 25000 }));
		const b = await ingestEvidence(e, alert({ fingerprint: "r2", txn_date: "2026-04-12", amount_minor: 4000, merchant_raw: "OTHER" }));
		await ingestEvidence(e, alert({ fingerprint: "r3", txn_date: "2026-04-20", amount_minor: 999, merchant_raw: "LATER" }));
		await addReimburseRange(e, "2026-04-10", "2026-04-17", "work trip");
		await setReimbursable(e, (b as { line_id: string }).line_id, 0);
		const ranges = await all<{ id: string; start_date: string; end_date: string; note: string | null }>("SELECT id, start_date, end_date, note FROM reimburse_ranges");
		expect(reimbursableTotal(await all<LineRow>("SELECT * FROM lines"), ranges)).toBe(25000);
		expect((await line((a as { line_id: string }).line_id)).reimbursable_override).toBeNull();
		expect(await all("SELECT actor, event FROM line_events WHERE event = 'reimbursable'")).toEqual([{ actor: "owner", event: "reimbursable" }]);
	});
});

describe("a month that does not add up", () => {
	it("is escalated to the senior model, its lines left posted, and a re-import is ignored", async () => {
		await ingestEvidence(e, alert({ fingerprint: "m1", institution: "citi", last4: "3333", amount_minor: 1000 }));
		const st = { account_id: CARD_C.id, period_start: "2026-02-16", period_end: "2026-03-15", currency: "SGD", opening_balance_minor: 0, closing_balance_minor: 1001, printed_net_minor: null };
		const s = await ingestStatement(e, st, [{ seq: 1, txn_date: "2026-03-10", currency: "SGD", amount_minor: 1000, merchant_raw: "TEST", kind_hint: "purchase" }]);
		expect(s.status === "imported" && s.recon).toMatchObject({ ok: false, difference_minor: -1 });
		const [row] = await all<Statement>("SELECT * FROM statements");
		expect(monthView(row!)).toMatchObject({ status: "escalated", difference: { minor: -1 }, problems: expect.arrayContaining([expect.objectContaining({ code: "ledger_mismatch" })]) });
		expect(await all("SELECT kind FROM escalations")).toEqual([{ kind: "month_failed" }]);
		expect(await all("SELECT state FROM lines")).toEqual([{ state: "posted" }]);
		expect(await ingestStatement(e, st, [])).toEqual({ status: "duplicate" });
	});
});
