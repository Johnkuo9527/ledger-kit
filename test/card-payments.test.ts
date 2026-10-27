/// The owner's rule (round 2, ask 5): every transfer from his bank account to one of
/// his credit cards is that card's bill — kind card_payment, never spending —
/// matched by the card issuer's name, or by the card's own "payment received"
/// line of exactly that amount within a few days. Transfers to people are never
/// guessed at. MADE-UP accounts and amounts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestEvidence, lookBackPayments } from "../src/engine";
import { cardPaymentTarget, classifyKind, findCardPaymentByAmount } from "../src/transfers";
import { ACCOUNTS, BANK, CARD_A, CARD_C, CARD_T, DEBIT, line } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, put, testEngine } from "./helpers/world";

const out = (merchant_raw: string, kind_hint: "transfer" | "payment" | null = "transfer") => ({ kind_hint, merchant_raw, amount_minor: 50_000, details: {} });

describe("classifyKind: a bank transfer to a card issuer is a card bill", () => {
	it.each([
		["FUNDS TRF TO CITIBANK", CARD_C.id],
		["BILL PAYMENT CITI", CARD_C.id],
		["REMITTANCE 台新銀行", CARD_T.id],
		["TT TAISHIN BANK", CARD_T.id],
	])("%s", (text, card) => {
		const r = classifyKind(out(text), BANK, ACCOUNTS, ["ALEX DOE"]);
		expect(r).toEqual({ kind: "card_payment", counter_account_id: card, review: false });
	});

	it("two cards at one issuer: still a card bill, the card left open", () => {
		const r = classifyKind(out("FAST TRANSFER HSBC"), BANK, ACCOUNTS, []);
		expect(r.kind).toBe("card_payment");
		expect(r.counter_account_id).toBeNull();
	});

	it("never guesses on a transfer to a person", () => {
		expect(classifyKind(out("PAYNOW TO JANE TAN"), BANK, ACCOUNTS, []).kind).toBe("purchase");
	});

	it("money coming IN from an issuer is not his card bill", () => {
		expect(classifyKind({ ...out("FUNDS TRF FROM CITIBANK"), amount_minor: -50_000 }, BANK, ACCOUNTS, []).kind).toBe("income");
	});

	it("a debit-card purchase at a shop that happens to say 'transfer' is still a purchase", () => {
		expect(classifyKind({ kind_hint: "purchase", merchant_raw: "CITI TRANSFER SHOP", amount_minor: 500, details: {} }, DEBIT, ACCOUNTS, []).kind).toBe("purchase");
	});
});

describe("findCardPaymentByAmount", () => {
	const banks = new Set([BANK.id]);
	const cardPaid = line({ id: "cp", account_id: CARD_C.id, kind: "card_payment", bill_minor: -50_000, orig_minor: -50_000, txn_date: "2026-03-10" });
	const bankOut = (id: string, txn_date: string, merchant_raw = "IBG 0012345") => line({ id, account_id: BANK.id, kind: "purchase", bill_minor: 50_000, orig_minor: 50_000, txn_date, merchant_raw });

	it("finds the bank line of exactly that amount within 5 days, both ways", () => {
		const b = bankOut("b1", "2026-03-07");
		expect(findCardPaymentByAmount(cardPaid, banks, [b])?.id).toBe("b1");
		expect(findCardPaymentByAmount(b, banks, [cardPaid])?.id).toBe("cp");
	});

	it("not 6 days away, not a cent off, not a PayNow", () => {
		expect(findCardPaymentByAmount(cardPaid, banks, [bankOut("b2", "2026-03-04")])).toBeNull();
		expect(findCardPaymentByAmount(cardPaid, banks, [{ ...bankOut("b3", "2026-03-09"), bill_minor: 50_001 }])).toBeNull();
		expect(findCardPaymentByAmount(cardPaid, banks, [bankOut("b4", "2026-03-09", "PAYNOW TO JANE TAN")])).toBeNull();
	});

	it("two equally near candidates: no answer, never a guess", () => {
		expect(findCardPaymentByAmount(cardPaid, banks, [bankOut("b5", "2026-03-09"), bankOut("b6", "2026-03-11")])).toBeNull();
		expect(findCardPaymentByAmount(cardPaid, banks, [bankOut("b7", "2026-03-09"), bankOut("b8", "2026-03-12")])?.id).toBe("b7");
	});
});

describe("cardPaymentTarget (the look back's reading of an old line)", () => {
	it("names the card when the descriptor carries its last 4", () => {
		expect(cardPaymentTarget({ account_id: BANK.id, kind: "purchase", bill_minor: 100, merchant_raw: `TRF TO CARD ${CARD_A.last4}` }, ACCOUNTS)).toEqual({ card_payment: true, counter_account_id: CARD_A.id });
	});
	it("leaves a card's own lines and a debit card's lines alone", () => {
		expect(cardPaymentTarget({ account_id: CARD_C.id, kind: "purchase", bill_minor: 100, merchant_raw: "HSBC TRANSFER" }, ACCOUNTS).card_payment).toBe(false);
		expect(cardPaymentTarget({ account_id: DEBIT.id, kind: "purchase", bill_minor: 100, merchant_raw: "HSBC TRANSFER" }, ACCOUNTS).card_payment).toBe(false);
	});
});

describe("in the ledger", () => {
	let db: TestDb;
	beforeEach(async () => {
		db = freshDb();
		await addAccounts(db);
	});
	afterEach(() => db.close());

	const kinds = async () => Object.fromEntries((db.raw.prepare("SELECT id, kind, transfer_group, counter_account_id FROM lines ORDER BY id").all() as { id: string; kind: string; transfer_group: string | null; counter_account_id: string | null }[]).map((r) => [r.id, r]));

	it("a new DBS alert paying Citi becomes a card payment and pairs with the card's payment received", async () => {
		const e = testEngine(db);
		await put(db, "lines", line({ id: "card-leg", account_id: CARD_C.id, kind: "card_payment", bill_minor: -50_000, orig_minor: -50_000, home_minor: -50_000, txn_date: "2026-03-11" }));
		const r = await ingestEvidence(e, { type: "alert", institution: "dbs", last4: BANK.last4, fingerprint: "a1", txn_date: "2026-03-10", currency: "SGD", amount_minor: 50_000, merchant_raw: "FUNDS TRF TO CITIBANK", kind_hint: "transfer" });
		expect(r.status).toBe("created");
		const k = await kinds();
		const bankLine = Object.values(k).find((x) => x.id !== "card-leg")!;
		expect(bankLine.kind).toBe("card_payment");
		expect(bankLine.counter_account_id).toBe(CARD_C.id);
		expect(bankLine.transfer_group).not.toBeNull();
		expect(k["card-leg"]!.transfer_group).toBe(bankLine.transfer_group);
	});

	it("the look back fixes old lines, logs each change, keeps evidence, and is idempotent", async () => {
		const e = testEngine(db);
		const bank = (id: string, merchant_raw: string, bill_minor: number, txn_date = "2026-02-02") =>
			put(db, "lines", line({ id, account_id: BANK.id, kind: "purchase", state: "posted", merchant_raw, bill_minor, orig_minor: bill_minor, home_minor: bill_minor, txn_date }));
		await bank("old-hsbc", `BILL PAYMENT HSBC ${CARD_A.last4}`, 12_000);
		await bank("old-ibg", "IBG 0099887", 34_500, "2026-02-20");
		await bank("old-friend", "PAYNOW TO JANE TAN", 34_500, "2026-02-20");
		await bank("old-shop", "SOME SHOP", 2_000);
		await put(db, "lines", line({ id: "citi-paid", account_id: CARD_C.id, kind: "card_payment", state: "posted", bill_minor: -34_500, orig_minor: -34_500, home_minor: -34_500, txn_date: "2026-02-22" }));

		let cursor: string | null = null;
		let pages = 0;
		do {
			const r = await lookBackPayments(e, cursor, 2);
			cursor = r.next;
			pages++;
		} while (cursor && pages < 10);
		const k = await kinds();
		expect(k["old-hsbc"]).toMatchObject({ kind: "card_payment", counter_account_id: CARD_A.id });
		expect(k["old-ibg"]).toMatchObject({ kind: "card_payment", counter_account_id: CARD_C.id });
		expect(k["old-ibg"]!.transfer_group).toBe(k["citi-paid"]!.transfer_group);
		expect(k["old-friend"]!.kind).toBe("purchase");
		expect(k["old-shop"]!.kind).toBe("purchase");
		const events = db.raw.prepare("SELECT line_id, event, actor FROM line_events WHERE event IN ('reclassify_card_payment', 'card_payment_by_amount') ORDER BY line_id").all();
		expect(events).toEqual([
			{ line_id: "old-hsbc", event: "reclassify_card_payment", actor: "rules" },
			{ line_id: "old-ibg", event: "card_payment_by_amount", actor: "rules" },
		]);

		const before = db.raw.prepare("SELECT COUNT(*) AS n FROM line_events").get();
		const again = await lookBackPayments(e, null, 50);
		expect(again).toEqual({ next: null, changed: 0 });
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM line_events").get()).toEqual(before);
	});

	it("a line whose kind the owner set himself is never touched", async () => {
		await put(db, "lines", line({ id: "owners", account_id: BANK.id, kind: "purchase", merchant_raw: "TRF TO CITIBANK", bill_minor: 1_000, orig_minor: 1_000 }));
		db.raw.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) VALUES ('owners', 'x', 'owner', 'edit', '{\"kind\":\"card_payment\"}', '{\"kind\":\"purchase\"}')").run();
		const r = await lookBackPayments(testEngine(db), null, 50);
		expect(r.changed).toBe(0);
		expect((await kinds())["owners"]!.kind).toBe("purchase");
	});
});
