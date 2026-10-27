import { describe, expect, it } from "vitest";
import {
	alertFingerprint,
	emailAddress,
	isOwnSummary,
	receiptFingerprint,
	statementLineFingerprint,
	SUMMARY_HEADER,
	SUMMARY_MARKER,
} from "../src/dedup";
import { classifyKind, findTransferPair, isSpending, type KindInput } from "../src/transfers";
import { ACCOUNTS, BANK, CARD_A, CARD_B, DEBIT, line } from "./helpers/fixtures";

describe("fingerprints", () => {
	const facts = {
		institution: "hsbc",
		last4: "1111",
		currency: "SGD",
		amount_minor: 450,
		txn_date: "2026-03-05",
		txn_time: "08:15",
		merchant_raw: "Kopi Corner #12",
	};

	it("calls a re-sent alert the same alert", () => {
		expect(alertFingerprint(facts)).toBe(alertFingerprint({ ...facts, merchant_raw: "KOPI CORNER #12" }));
	});

	it("keeps two coffees a minute apart as two", () => {
		expect(alertFingerprint(facts)).not.toBe(alertFingerprint({ ...facts, txn_time: "08:16" }));
	});

	it("identifies a receipt by its order number, else by its message", () => {
		expect(receiptFingerprint("Shop.example", "A-123", "m1")).toBe(receiptFingerprint("shop.example", " A-123 ", "m2"));
		expect(receiptFingerprint("shop.example", null, "m1")).not.toBe(receiptFingerprint("shop.example", null, "m2"));
	});

	it("tells two identical statement lines apart by position", () => {
		expect(statementLineFingerprint("S1", 4)).not.toBe(statementLineFingerprint("S1", 5));
	});
});

describe("the ledger never reads its own weekly summary", () => {
	const summaryFrom = "ledger@example.dev";
	const receipt = { from: "Shop <orders@shop.example>", subject: "Your order", headers: {}, body: "Total SGD 12.00" };

	it("by its header, case-insensitively", () => {
		expect(isOwnSummary({ ...receipt, headers: { [SUMMARY_HEADER.toLowerCase()]: "1" } }, summaryFrom)).toBe(true);
	});

	it("by its sender", () => {
		expect(isOwnSummary({ ...receipt, from: "Ledger <LEDGER@example.dev>" }, summaryFrom)).toBe(true);
		expect(emailAddress("Ledger <LEDGER@example.dev>")).toBe("ledger@example.dev");
	});

	it("when the owner forwards it, by the marker in the body", () => {
		const forwarded = { from: "owner@example.com", subject: "Fwd: Your week", headers: {}, body: `---------- Forwarded\n${SUMMARY_MARKER}\nGRAB SGD 12.00` };
		expect(isOwnSummary(forwarded, summaryFrom)).toBe(true);
	});

	it("but not a real receipt, even one titled 'Ledger'", () => {
		expect(isOwnSummary(receipt, summaryFrom)).toBe(false);
		expect(isOwnSummary({ ...receipt, subject: "Ledger weekly summary" }, summaryFrom)).toBe(false);
	});
});

describe("paying a card and moving money between own accounts is never spending", () => {
	const own = ["ALEX DOE"];
	const input = (over: Partial<KindInput>): KindInput => ({ kind_hint: null, merchant_raw: null, amount_minor: 1000, details: {}, ...over });

	it("a payment arriving on a credit card", () => {
		const r = classifyKind(input({ merchant_raw: "PAYMENT - THANK YOU", amount_minor: -50000 }), CARD_A, ACCOUNTS, own);
		expect(r).toEqual({ kind: "card_payment", counter_account_id: null, review: false });
	});

	it("a credit on a card that is not a payment is a refund", () => {
		expect(classifyKind(input({ merchant_raw: "ZARA ION", amount_minor: -2500 }), CARD_A, ACCOUNTS, own).kind).toBe("refund");
	});

	it("a bank payment naming one of his cards by number", () => {
		const r = classifyKind(input({ merchant_raw: "BILL PAYMENT TO HSBC CARD 1111", amount_minor: 50000 }), BANK, ACCOUNTS, own);
		expect(r).toEqual({ kind: "card_payment", counter_account_id: CARD_A.id, review: false });
	});

	it("a bank payment naming only the issuer (two HSBC cards: which one is unknown)", () => {
		const r = classifyKind(input({ merchant_raw: "HSBC CARD PAYMENT", amount_minor: 30000 }), BANK, ACCOUNTS, own);
		expect(r).toEqual({ kind: "card_payment", counter_account_id: null, review: false });
	});

	it("a counterparty card number from the parser", () => {
		const r = classifyKind(input({ kind_hint: "payment", merchant_raw: "IBG", amount_minor: 30000, details: { counterparty: { last4: "2222" } } }), BANK, ACCOUNTS, own);
		expect(r.kind).toBe("card_payment");
		expect(r.counter_account_id).toBe(CARD_B.id);
	});

	it("a card bill at an issuer he has not listed: not spending, held for a look", () => {
		const r = classifyKind(input({ merchant_raw: "UOB CARD PAYMENT", amount_minor: 10000 }), BANK, ACCOUNTS, own);
		expect(r).toEqual({ kind: "card_payment", counter_account_id: null, review: true });
	});

	it("a utility BILL payment is spending, not a card payment", () => {
		expect(classifyKind(input({ merchant_raw: "BILL PAYMENT SP SERVICES", amount_minor: 12000 }), BANK, ACCOUNTS, own).kind).toBe("purchase");
	});

	it("PayNow to himself is a transfer; to a friend it is spending; from a friend it is income", () => {
		expect(classifyKind(input({ kind_hint: "transfer", merchant_raw: "PAYNOW TRANSFER", details: { counterparty: { name: "Alex Doe" } } }), BANK, ACCOUNTS, own).kind).toBe("transfer");
		expect(classifyKind(input({ kind_hint: "transfer", merchant_raw: "PAYNOW TO ALICE TAN", amount_minor: 4000 }), BANK, ACCOUNTS, own).kind).toBe("purchase");
		expect(classifyKind(input({ kind_hint: "transfer", merchant_raw: "PAYNOW FROM ALICE TAN", amount_minor: -4000 }), BANK, ACCOUNTS, own).kind).toBe("income");
	});

	it("a word inside a word is not a transfer ('BREAKFAST' is not FAST)", () => {
		expect(classifyKind(input({ merchant_raw: "ALEX DOE BREAKFAST CLUB", amount_minor: 1000 }), BANK, ACCOUNTS, own).kind).toBe("purchase");
	});

	it("a cash withdrawal moves money into the cash wallet", () => {
		expect(classifyKind(input({ kind_hint: "atm", amount_minor: 20000 }), DEBIT, ACCOUNTS, own)).toEqual({ kind: "transfer", counter_account_id: "cash", review: false });
	});

	it("counts only purchases, fees and refunds as spending", () => {
		expect(isSpending({ kind: "purchase", state: "open" })).toBe(true);
		expect(isSpending({ kind: "refund", state: "posted" })).toBe(true);
		expect(isSpending({ kind: "card_payment", state: "open" })).toBe(false);
		expect(isSpending({ kind: "transfer", state: "open" })).toBe(false);
		expect(isSpending({ kind: "income", state: "open" })).toBe(false);
		expect(isSpending({ kind: "purchase", state: "void" })).toBe(false);
	});

	it("pairs the two legs of a card payment, preferring the named card", () => {
		const bankLeg = line({ id: "bank-leg", account_id: BANK.id, kind: "card_payment", bill_minor: 50000, orig_minor: 50000, txn_date: "2026-03-03" });
		const onCardA = line({ id: "card-a-leg", account_id: CARD_A.id, kind: "card_payment", bill_minor: -50000, orig_minor: -50000, txn_date: "2026-03-05" });
		const onCardB = line({ id: "card-b-leg", account_id: CARD_B.id, kind: "card_payment", bill_minor: -50000, orig_minor: -50000, txn_date: "2026-03-03" });
		const wrongSize = line({ account_id: CARD_A.id, kind: "card_payment", bill_minor: -49999, txn_date: "2026-03-03" });
		const tooLate = line({ account_id: CARD_A.id, kind: "card_payment", bill_minor: -50000, txn_date: "2026-03-07" });
		const all = [onCardB, onCardA, wrongSize, tooLate];
		expect(findTransferPair(bankLeg, CARD_A.id, all)?.id).toBe("card-a-leg");
		expect(findTransferPair(bankLeg, null, all)?.id).toBe("card-b-leg"); // nearest date
		expect(findTransferPair({ ...bankLeg, kind: "purchase" }, null, all)).toBeNull();
		expect(findTransferPair(bankLeg, null, [{ ...onCardA, transfer_group: "g1" }])).toBeNull();
	});
});
