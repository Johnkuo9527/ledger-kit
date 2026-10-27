import { describe, expect, it } from "vitest";
import { feeTarget, isForeign, matchEvidence, type Candidate, type MatchInput } from "../src/matching";
import { findRefundOriginal } from "../src/refunds";
import type { EvidenceType, LineRow } from "../src/types";
import { BANK, CARD_A, CARD_B, DEBIT, line } from "./helpers/fixtures";

const cand = (l: LineRow, ...has: EvidenceType[]): Candidate => ({ line: l, has: new Set(has) });
const onCardA = new Set([CARD_A.id]);
const input = (over: Partial<MatchInput>): MatchInput => ({
	type: "statement_line",
	account_ids: onCardA,
	kind: "purchase",
	currency: "SGD",
	amount_minor: 1000,
	txn_date: "2026-03-05",
	merchant_key: "TEST MERCHANT",
	...over,
});

describe("one purchase, one line", () => {
	it("starts a line when nothing fits", () => {
		expect(matchEvidence(input({ type: "alert" }), [])).toEqual({ action: "create" });
	});

	it("attaches a statement line to the alert's line", () => {
		const fromAlert = line({ id: "A", merchant_key: "KOPI CORNER" });
		const d = matchEvidence(input({ merchant_key: "KOPI CORNER", txn_date: "2026-03-07" }), [cand(fromAlert, "alert")]);
		expect(d).toEqual({ action: "attach", line_id: "A", via: "exact", merchant_score: 1 });
	});

	it("pairs two identical coffees with two statement lines, in order", () => {
		const first = line({ id: "first", merchant_key: "KOPI", orig_minor: 450, bill_minor: 450, created_at: "2026-03-05T01:00:00.000Z" });
		const second = line({ id: "second", merchant_key: "KOPI", orig_minor: 450, bill_minor: 450, created_at: "2026-03-05T01:05:00.000Z" });
		const ev = input({ merchant_key: "KOPI", amount_minor: 450 });
		const d1 = matchEvidence(ev, [cand(second, "alert"), cand(first, "alert")]);
		expect(d1).toMatchObject({ action: "attach", line_id: "first" });
		const d2 = matchEvidence(ev, [cand(second, "alert"), cand(first, "alert", "statement_line")]);
		expect(d2).toMatchObject({ action: "attach", line_id: "second" });
	});

	it("never gives one line two alerts", () => {
		const l = line({ merchant_key: "KOPI" });
		expect(matchEvidence(input({ type: "alert", merchant_key: "KOPI" }), [cand(l, "alert")])).toEqual({ action: "create" });
	});

	it("holds to the 3-day window", () => {
		const l = line({ txn_date: "2026-03-01" });
		expect(matchEvidence(input({ txn_date: "2026-03-04" }), [cand(l, "alert")]).action).toBe("attach");
		expect(matchEvidence(input({ txn_date: "2026-03-05" }), [cand(l, "alert")]).action).toBe("create");
	});

	it("never matches a refund to a purchase, a void line, or another card", () => {
		const l = line({});
		expect(matchEvidence(input({ kind: "refund", amount_minor: -1000 }), [cand(l, "alert")]).action).toBe("create");
		expect(matchEvidence(input({}), [cand({ ...l, state: "void" }, "alert")]).action).toBe("create");
		expect(matchEvidence(input({ account_ids: new Set([CARD_B.id]) }), [cand(l, "alert")]).action).toBe("create");
	});

	it("holds a line the two sources sorted into different kinds, rather than count it twice", () => {
		const asTransfer = line({ id: "T", kind: "transfer", merchant_key: "PAYNOW ALICE" });
		expect(matchEvidence(input({ kind: "purchase", merchant_key: "PAYNOW ALICE" }), [cand(asTransfer, "alert")])).toMatchObject({
			action: "review",
			candidate_ids: ["T"],
			reason: "same amount and date as a line of a different kind",
		});
	});

	it("finds a DBS debit-card purchase from the DBS bank statement", () => {
		const onDebit = line({ id: "D", account_id: DEBIT.id });
		const d = matchEvidence(input({ account_ids: new Set([BANK.id, DEBIT.id]) }), [cand(onDebit, "alert")]);
		expect(d).toMatchObject({ action: "attach", line_id: "D" });
	});

	it("matches a statement that prints only the billed SGD of a foreign charge, within 4%", () => {
		// Estimate SGD 139.39 for USD 100.00. Billed 139.50 is 0.08% away; 145.00 is 4.02% away.
		const fx = line({ id: "FX", orig_currency: "USD", orig_minor: 10000, bill_minor: 13939, bill_status: "estimate", merchant_key: "HOTEL" });
		expect(matchEvidence(input({ amount_minor: 13950, merchant_key: "HOTEL" }), [cand(fx, "alert")])).toMatchObject({ action: "attach", via: "tolerance" });
		expect(matchEvidence(input({ amount_minor: 14500, merchant_key: "HOTEL" }), [cand(fx, "alert")]).action).toBe("create");
		// An alert never uses the tolerance — it states the foreign amount.
		expect(matchEvidence(input({ type: "alert", amount_minor: 13950, merchant_key: "HOTEL" }), [cand(fx)]).action).toBe("create");
	});

	it("prefers the more similar merchant, then the nearer date", () => {
		const far = line({ id: "far", merchant_key: "KOPI CORNER", txn_date: "2026-03-03" });
		const near = line({ id: "near", merchant_key: "KOPI CORNER", txn_date: "2026-03-05" });
		const other = line({ id: "other", merchant_key: "BOOKSHOP", txn_date: "2026-03-05" });
		expect(matchEvidence(input({ merchant_key: "KOPI CORNER" }), [cand(far, "alert"), cand(other, "alert"), cand(near, "alert")])).toMatchObject({ line_id: "near" });
	});

	it("takes a terse bank descriptor when only one purchase fits", () => {
		const l = line({ id: "only", merchant_key: "KOPI CORNER" });
		expect(matchEvidence(input({ merchant_key: "NETS 0042" }), [cand(l, "alert")])).toMatchObject({ action: "attach", line_id: "only" });
	});

	it("asks rather than guesses when several different purchases fit and the name picks none", () => {
		const a = line({ id: "a", merchant_key: "KOPI CORNER" });
		const b = line({ id: "b", merchant_key: "BOOKSHOP" });
		const d = matchEvidence(input({ merchant_key: "NETS 0042" }), [cand(a, "alert"), cand(b, "alert")]);
		expect(d).toMatchObject({ action: "review", candidate_ids: expect.arrayContaining(["a", "b"]) });
	});
});

describe("receipts never start a line on their own", () => {
	const r = (over: Partial<MatchInput>) => input({ type: "receipt", account_ids: null, ...over });

	it("attaches to the payment with a similar merchant on any account", () => {
		const l = line({ id: "P", account_id: CARD_B.id, merchant_key: "SHOPEE MP" });
		expect(matchEvidence(r({ merchant_key: "SHOPEE" }), [cand(l, "alert")])).toMatchObject({ action: "attach", line_id: "P" });
	});

	it("takes the only exact payment within a day even under another name", () => {
		const l = line({ id: "P", merchant_key: "FAST RETAILING", txn_date: "2026-03-04" });
		expect(matchEvidence(r({ merchant_key: "UNIQLO" }), [cand(l, "alert")])).toMatchObject({ action: "attach", line_id: "P" });
	});

	it("waits when nothing fits, or only an unrelated merchant two days away", () => {
		expect(matchEvidence(r({}), [])).toMatchObject({ action: "hold" });
		const l = line({ merchant_key: "FAST RETAILING", txn_date: "2026-03-03" });
		expect(matchEvidence(r({ merchant_key: "UNIQLO" }), [cand(l, "alert")])).toMatchObject({ action: "hold" });
	});

	it("never takes a second receipt onto one line", () => {
		const l = line({ merchant_key: "SHOPEE" });
		expect(matchEvidence(r({ merchant_key: "SHOPEE" }), [cand(l, "alert", "receipt")])).toMatchObject({ action: "hold" });
	});
});

describe("the overseas fee belongs to its purchase", () => {
	const usd = line({ id: "usd", orig_currency: "USD", orig_minor: 10000, bill_minor: 13500, bill_status: "confirmed", txn_date: "2026-03-05" });
	const local = line({ id: "local", bill_minor: 2000, txn_date: "2026-03-05" });

	it("attaches to the foreign charge just before it", () => {
		// 1.0% fee: SGD 1.35 on SGD 135.00 — well under the 5% ceiling.
		const rows = [
			{ seq: 1, kind_hint: "purchase", txn_date: "2026-03-05", line: usd },
			{ seq: 2, kind_hint: "fx_fee", txn_date: "2026-03-05", line: null },
		];
		expect(feeTarget({ seq: 2, txn_date: "2026-03-05", amount_minor: 135 }, rows)).toBe("usd");
	});

	it("skips a domestic line in between, finding the only foreign charge that day", () => {
		const rows = [
			{ seq: 1, kind_hint: "purchase", txn_date: "2026-03-05", line: usd },
			{ seq: 2, kind_hint: "purchase", txn_date: "2026-03-05", line: local },
			{ seq: 3, kind_hint: "fx_fee", txn_date: "2026-03-05", line: null },
		];
		expect(feeTarget({ seq: 3, txn_date: "2026-03-05", amount_minor: 135 }, rows)).toBe("usd");
	});

	it("stands alone when it is too big to be a fee on anything", () => {
		// SGD 7.00 on SGD 135.00 is 5.2%.
		const rows = [{ seq: 1, kind_hint: "purchase", txn_date: "2026-03-05", line: usd }];
		expect(feeTarget({ seq: 2, txn_date: "2026-03-05", amount_minor: 700 }, rows)).toBeNull();
	});

	it("knows what is foreign", () => {
		expect(isForeign({ orig_currency: "USD", bill_currency: "SGD", merchant_country: null })).toBe(true);
		expect(isForeign({ orig_currency: "SGD", bill_currency: "SGD", merchant_country: "JP" })).toBe(true); // SGD charged abroad
		expect(isForeign({ orig_currency: "SGD", bill_currency: "SGD", merchant_country: "SG" })).toBe(false);
		expect(isForeign({ orig_currency: "TWD", bill_currency: "TWD", merchant_country: "TW" })).toBe(false);
	});
});

describe("refunds link to the original purchase", () => {
	const big = line({ id: "big", merchant_key: "ZARA", orig_minor: 8000, bill_minor: 8000, txn_date: "2026-03-01" });
	const small = line({ id: "small", merchant_key: "ZARA", orig_minor: 3000, bill_minor: 3000, txn_date: "2026-03-05" });
	const refund = (amount: number, over: Partial<LineRow> = {}) =>
		line({ kind: "refund", merchant_key: "ZARA", orig_minor: -amount, bill_minor: -amount, txn_date: "2026-03-10", ...over });

	it("prefers the purchase of exactly that amount", () => {
		expect(findRefundOriginal(refund(3000), [big, small], new Map())?.id).toBe("small");
		expect(findRefundOriginal(refund(8000), [big, small], new Map())?.id).toBe("big");
	});

	it("otherwise the most recent purchase with enough left to give back", () => {
		expect(findRefundOriginal(refund(2000), [big, small], new Map())?.id).toBe("small");
		// SGD 20.00 already returned from 'small' leaves SGD 10.00 — not enough.
		expect(findRefundOriginal(refund(2000), [big, small], new Map([["small", 2000]]))?.id).toBe("big");
	});

	it("finds nothing on another card, another shop, before the purchase, or after 180 days", () => {
		expect(findRefundOriginal(refund(3000, { account_id: CARD_B.id }), [big, small], new Map())).toBeNull();
		expect(findRefundOriginal(refund(3000, { merchant_key: "H M" }), [big, small], new Map())).toBeNull();
		expect(findRefundOriginal(refund(3000, { txn_date: "2026-02-28" }), [big, small], new Map())).toBeNull();
		expect(findRefundOriginal(refund(3000, { txn_date: "2026-09-02" }), [small], new Map())).toBeNull(); // 181 days
		expect(findRefundOriginal(refund(3000, { txn_date: "2026-09-01" }), [small], new Map())?.id).toBe("small"); // 180 days
	});
});
