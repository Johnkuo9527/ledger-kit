/// 14 Oct 2026: "台新 too — I already paid." 台新 is paid by
/// auto-debit from a bank account the ledger does not track, so its payment
/// shows only on the NEXT statement. 繳款 must not say 逾期 without evidence:
/// an auto-debit card past its due date is `autopay_pending`; the next
/// statement then says paid (payments cover the old bill) or not (a balance
/// carried, a late fee) — only then a real overdue, with a 待確認 item. The owner's
/// 「我已繳款」 marks a bill paid; the next statement still checks it.
/// MADE-UP accounts and amounts (TWD 1.00 = 100 minor units).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markBillPaid, markUnpaidSeen, paymentsView, setAutopay } from "../src/payments";
import { billItems, needsOk } from "../src/queries";
import { account, CARD_A, CARD_T, line, statement } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, put, testEngine } from "./helpers/world";

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
});
afterEach(() => db.close());

const AUTO = "台新銀行帳戶自動轉帳扣繳台新信用卡款";
const tw = (over: Parameters<typeof statement>[0]) => statement({ currency: "TWD", recon_status: "reconciled", ...over });
/// 台新's September bill: closed 13 Sep, TWD 5,000 to pay by 1 Oct; it lists August's auto-debit.
const SEP = () => tw({ id: "t-sep", account_id: CARD_T.id, period_start: "2026-08-14", period_end: "2026-09-13", previous_balance_minor: 300_000, payments_credited_minor: 300_000, statement_balance_minor: 500_000, minimum_due_minor: 50_000, due_date: "2026-10-01" });
const payLine = (id: string, statement_id: string | null, txn_date: string, minor: number, merchant_raw = AUTO, account_id = CARD_T.id) =>
	line({ id, account_id, kind: "card_payment", statement_id, txn_date, merchant_raw, merchant_key: "AUTO", orig_currency: "TWD", orig_minor: -minor, bill_currency: "TWD", bill_minor: -minor, home_minor: -Math.round(minor / 25), home_status: "reference", state: "reconciled" });
const row = async (today: string, id: string = CARD_T.id) => (await paymentsView(db, today)).cards.find((c) => c.account.id === id)!;

describe("an auto-debit card past its due date is not 逾期", () => {
	it("the statement shows an auto-debit payment: autopay_pending, out of the to-pay total", async () => {
		await put(db, "statements", SEP());
		await put(db, "lines", payLine("aug-debit", "t-sep", "2026-08-27", 300_000));
		const r = await row("2026-10-14");
		expect(r).toMatchObject({ status: "autopay_pending", status_reason: null, autopay: { on: true, source: "statement" }, outstanding: { minor: 500_000 } });
		expect((await paymentsView(db, "2026-10-14")).total.outstanding_home.minor).toBe(0);
		// Before the due date it is simply due (and counted).
		expect(await row("2026-09-20")).toMatchObject({ status: "due" });
	});

	it("no auto-debit line and no payment seen: overdue, and 待確認 offers 「我已繳款」", async () => {
		await put(db, "statements", SEP());
		await put(db, "lines", payLine("aug-pay", "t-sep", "2026-08-27", 300_000, "PAYMENT - THANK YOU"));
		const r = await row("2026-10-14");
		expect(r).toMatchObject({ status: "overdue", status_reason: "no_payment_seen", autopay: { on: false, source: null } });
		const items = billItems([r]);
		expect(items.map((i) => [i.kind, i.actions.map((a) => [a.label, a.path, a.body])])).toEqual([
			["overdue", [["我已繳款", "/api/payments/t-sep/paid", { paid: true }], ["這張卡是自動扣繳", `/api/accounts/${CARD_T.id}/settings`, { autopay: true }]]],
		]);
	});

	it("The owner's word beats the statements, both ways", async () => {
		await put(db, "statements", SEP());
		await put(db, "lines", payLine("aug-debit", "t-sep", "2026-08-27", 300_000));
		const e = testEngine(db, "owner");
		await setAutopay(e, CARD_T.id, false);
		expect(await row("2026-10-14")).toMatchObject({ status: "overdue", autopay: { on: false, source: "owner" } });
		await setAutopay(e, CARD_T.id, true);
		expect(await row("2026-10-14")).toMatchObject({ status: "autopay_pending", autopay: { on: true, source: "owner" } });
		await setAutopay(e, CARD_T.id, null);
		expect(await row("2026-10-14")).toMatchObject({ status: "autopay_pending", autopay: { on: true, source: "statement" } });
		await expect(setAutopay(e, "bank-x", true)).rejects.toThrow(/only a credit card/);
	});
});

describe("the next statement checks the bill before it", () => {
	beforeEach(async () => {
		await put(db, "statements", SEP());
		await put(db, "lines", payLine("aug-debit", "t-sep", "2026-08-27", 300_000));
	});

	it("it shows the payment: the old bill is paid, nothing for 待確認", async () => {
		await put(db, "statements", tw({ id: "t-oct", account_id: CARD_T.id, period_start: "2026-09-14", period_end: "2026-10-13", previous_balance_minor: 500_000, payments_credited_minor: 500_000, statement_balance_minor: 200_000, due_date: "2026-11-01" }));
		await put(db, "lines", payLine("sep-debit", "t-oct", "2026-09-29", 500_000));
		const r = await row("2026-10-20");
		expect(r).toMatchObject({ status: "due", last_statement: { statement_id: "t-oct" }, previous_bill: { statement_id: "t-sep", verdict: "paid", reason: "payments_cover_it" } });
		expect(billItems([r])).toEqual([]);
	});

	it("no payments figure printed: the auto-debit line on the new bill is the evidence", async () => {
		await put(db, "statements", tw({ id: "t-oct", account_id: CARD_T.id, period_start: "2026-09-14", period_end: "2026-10-13", previous_balance_minor: 500_000, statement_balance_minor: 200_000, due_date: "2026-11-01" }));
		await put(db, "lines", payLine("sep-debit", "t-oct", "2026-09-29", 500_000));
		expect((await row("2026-10-20")).previous_bill).toMatchObject({ verdict: "paid", payments_credited: { minor: 500_000 } });
	});

	it("it shows a balance carried: a real overdue, and 待確認 says so until the owner has seen it", async () => {
		await put(db, "statements", tw({ id: "t-oct", account_id: CARD_T.id, period_start: "2026-09-14", period_end: "2026-10-13", previous_balance_minor: 500_000, payments_credited_minor: 0, statement_balance_minor: 700_000, due_date: "2026-11-01" }));
		const r = await row("2026-10-20");
		expect(r).toMatchObject({ status: "overdue", status_reason: "previous_unpaid", previous_bill: { statement_id: "t-sep", verdict: "unpaid", reason: "balance_carried", owner_said_paid: false, seen_by_owner: false } });
		const n = await needsOk(db, { today: "2026-10-20" });
		expect(n.bills.map((b) => [b.kind, b.title, b.actions.map((a) => a.path)])).toEqual([["unpaid_on_next_statement", `${CARD_T.id} 9月13日結帳的帳單沒有繳清`, ["/api/payments/t-sep/seen"]]]);
		expect(n.bills[0]!.detail).toContain("只繳了 TWD 0.00（帳單是 TWD 5,000.00），還差 TWD 5,000.00");
		expect(n.count).toBe(1);
		await markUnpaidSeen(testEngine(db, "owner"), "t-sep");
		expect((await needsOk(db, { today: "2026-10-20" })).bills).toEqual([]);
		// Seen is not paid: 繳款 still says so until the carried amount is paid.
		expect(await row("2026-10-20")).toMatchObject({ status: "overdue", status_reason: "previous_unpaid" });
	});

	it("a late fee on the new bill is evidence too", async () => {
		await put(db, "statements", tw({ id: "t-oct", account_id: CARD_T.id, period_start: "2026-09-14", period_end: "2026-10-13", statement_balance_minor: 760_000, due_date: "2026-11-01" }));
		await put(db, "lines", line({ id: "late", account_id: CARD_T.id, kind: "fee", statement_id: "t-oct", txn_date: "2026-10-02", merchant_raw: "逾期手續費", orig_currency: "TWD", orig_minor: 30_000, bill_currency: "TWD", bill_minor: 30_000, home_minor: 1200 }));
		expect(await row("2026-10-20")).toMatchObject({ status: "overdue", previous_bill: { verdict: "unpaid", reason: "late_fee_or_interest" } });
	});
});

describe("The owner's 「我已繳款」", () => {
	const HSBC = () => statement({ id: "a-sep", account_id: CARD_A.id, period_start: "2026-08-15", period_end: "2026-09-14", statement_balance_minor: 16_294, previous_balance_minor: 0, due_date: "2026-10-08", recon_status: "reconciled" });

	it("marks the bill paid (source owner); taking it back returns to what the ledger sees", async () => {
		await put(db, "statements", HSBC());
		expect(await row("2026-10-14", CARD_A.id)).toMatchObject({ status: "overdue", status_reason: "no_payment_seen" });
		await markBillPaid(testEngine(db, "owner"), "a-sep", true);
		expect(await row("2026-10-14", CARD_A.id)).toMatchObject({ status: "paid", paid_source: "owner", outstanding: { minor: 16_294 } });
		expect((await needsOk(db, { today: "2026-10-14" })).bills).toEqual([]);
		await markBillPaid(testEngine(db, "owner"), "a-sep", false);
		expect(await row("2026-10-14", CARD_A.id)).toMatchObject({ status: "overdue", paid_source: null });
	});

	it("the next statement disagrees: 待確認 says he said paid but the bill did not", async () => {
		await put(db, "statements", HSBC());
		await markBillPaid(testEngine(db, "owner"), "a-sep", true);
		await put(db, "statements", statement({ id: "a-oct", account_id: CARD_A.id, period_start: "2026-09-15", period_end: "2026-10-14", previous_balance_minor: 16_294, payments_credited_minor: 0, statement_balance_minor: 20_000, due_date: "2026-11-08", recon_status: "reconciled" }));
		const r = await row("2026-10-16", CARD_A.id);
		expect(r).toMatchObject({ status: "overdue", status_reason: "previous_unpaid", previous_bill: { verdict: "unpaid", owner_said_paid: true } });
		const [item] = (await needsOk(db, { today: "2026-10-16" })).bills;
		expect(item!.detail).toContain("你之前說已繳款，但帳單上看起來沒有繳清");
	});

	it("refuses a statement that is not a card's bill", async () => {
		await expect(markBillPaid(testEngine(db, "owner"), "nope", true)).rejects.toThrow(/no such card bill/);
	});
});

describe("台新: one bill for every card — a payment on a lost card's piece counts for the bill's row", () => {
	const LOST = account({ id: "card-t-old", institution: "taishin", kind: "credit_card", currency: "TWD", last4: "6666", active: 0, alerts_expected: 0, replaced_by: CARD_T.id });
	const OTHER = account({ id: "card-t2", institution: "taishin", kind: "credit_card", currency: "TWD", last4: "7777", alerts_expected: 0 });

	it("the auto-debit printed under the lost card's heading still makes the row autopay; a later payment on it counts", async () => {
		await addAccounts(db, [OTHER, { ...LOST, replaced_by: null }]);
		db.raw.prepare("UPDATE accounts SET replaced_by = ? WHERE id = ?").run(CARD_T.id, LOST.id);
		// The lost card's last bill alone (read before the split), and September's bill split on card-t2 (primary) and card-t.
		await put(db, "statements", tw({ id: "old-jul", account_id: LOST.id, period_start: "2026-06-14", period_end: "2026-07-13", statement_balance_minor: 100_000, due_date: "2026-08-01" }));
		await put(db, "statements", tw({ ...SEP(), id: "sep-main", account_id: OTHER.id, bill_group: "g:0", bill_primary: 1 }));
		await put(db, "statements", tw({ id: "sep-t", account_id: CARD_T.id, period_start: "2026-08-14", period_end: "2026-09-13", bill_group: "g:0", bill_primary: 0 }));
		await put(db, "statements", tw({ id: "sep-lost", account_id: LOST.id, period_start: "2026-08-14", period_end: "2026-09-13", bill_group: "g:1", bill_primary: 1 }));
		await put(db, "lines", payLine("aug-debit", "sep-lost", "2026-08-27", 300_000, AUTO, LOST.id));
		const taishin = async () => (await paymentsView(db, "2026-10-14")).cards.filter((c) => c.account.institution === "taishin");
		const v = await taishin();
		expect(v.map((c) => c.account.id)).toEqual([OTHER.id]); // one row: what he pays
		expect(v[0]).toMatchObject({ status: "autopay_pending", autopay: { on: true, source: "statement" } });
		// The owner pays the rest from the lost card's number by hand after the cut-off: it counts for the row.
		await put(db, "lines", { ...payLine("by-hand", null, "2026-09-20", 500_000, "PAYMENT", LOST.id), state: "open" });
		expect((await taishin())[0]).toMatchObject({ status: "paid", paid_source: "ledger", paid_since_statement: { minor: 500_000 } });
	});
});
