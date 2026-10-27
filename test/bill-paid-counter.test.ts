/// 14 Oct 2026: "Why does 5502 show 逾期? I paid." A DBS line
/// "Other bank's card ending 5502" paid the card's bill in full, but its
/// counter account was never filled in, and 繳款 only counted a bank payment
/// whose counter account IS the card. Fixed three ways: such a line always
/// names the card; 繳款 reads the card from the descriptor when the counter is
/// empty; a one-time upkeep fills the counter on old lines (never the owner's own).
/// MADE-UP accounts and amounts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fillCardCounters, setLineKind } from "../src/engine";
import { paymentsView } from "../src/payments";
import { classifyKind } from "../src/transfers";
import { account, ACCOUNTS, BANK, CARD_A, line, statement } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, put, testEngine } from "./helpers/world";

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
});
afterEach(() => db.close());

const TODAY = "2026-10-14";
/// Card A's bill: closed 14 Sep, S$162.94, due 8 Oct — six days ago.
const bill = () => statement({ id: "bill-a", account_id: CARD_A.id, period_start: "2026-08-15", period_end: "2026-09-14", statement_balance_minor: 16_294, previous_balance_minor: 0, due_date: "2026-10-08", recon_status: "reconciled" });
const payment = (over: Parameters<typeof line>[0] = {}) =>
	line({ id: "pay", account_id: BANK.id, kind: "card_payment", txn_date: "2026-09-26", merchant_raw: "Other bank's card ending 1111", merchant_key: "OTHER BANK S CARD ENDING", orig_minor: 16_294, bill_minor: 16_294, home_minor: 16_294, ...over });
const cardA = async () => (await paymentsView(db, TODAY)).cards.find((c) => c.account.id === CARD_A.id)!;

describe("the DBS line that paid a card names that card", () => {
	it("classifyKind: 'Other bank's card ending 1111' is card A's bill", () => {
		const r = classifyKind({ kind_hint: "payment", merchant_raw: "Other bank's card ending 1111", amount_minor: 16_294, details: {} }, BANK, ACCOUNTS, []);
		expect(r).toEqual({ kind: "card_payment", counter_account_id: CARD_A.id, review: false });
	});

	it("even when a debit card at another bank shares the digits", () => {
		const twin = account({ id: "twin", institution: "dbs", kind: "debit_card", currency: "SGD", last4: "1111", settles_to: BANK.id });
		const r = classifyKind({ kind_hint: "transfer", merchant_raw: "Other bank's card ending 1111", amount_minor: 16_294, details: {} }, BANK, [...ACCOUNTS, twin], []);
		expect(r).toEqual({ kind: "card_payment", counter_account_id: CARD_A.id, review: false });
	});

	it("The owner calling a bank line a card bill fills in the card it names", async () => {
		await put(db, "lines", payment({ kind: "purchase" }));
		const after = await setLineKind(testEngine(db, "owner"), "pay", "card_payment");
		expect([after.kind, after.counter_account_id]).toEqual(["card_payment", CARD_A.id]);
	});
});

describe("繳款: a bank payment counts for the card it paid", () => {
	it("with the card as its counter account: paid", async () => {
		await put(db, "statements", bill());
		await put(db, "lines", payment({ counter_account_id: CARD_A.id }));
		expect(await cardA()).toMatchObject({ status: "paid", paid_since_statement: { minor: 16_294 }, outstanding: { minor: 0 } });
	});

	it("with NO counter account, the descriptor names the card: paid (the 5502 case)", async () => {
		await put(db, "statements", bill());
		await put(db, "lines", payment());
		expect(await cardA()).toMatchObject({ status: "paid", paid_since_statement: { minor: 16_294 } });
	});

	it("a payment naming no card of his does not pay card A: still overdue", async () => {
		await put(db, "statements", bill());
		await put(db, "lines", payment({ merchant_raw: "Other bank's card ending 9999", merchant_key: "X" }));
		expect(await cardA()).toMatchObject({ status: "overdue", paid_since_statement: { minor: 0 } });
	});
});

describe("upkeep: fill the card on old bank card bills, once", () => {
	it("fills the counter account, then has nothing left to do", async () => {
		await put(db, "lines", payment());
		const e = testEngine(db);
		expect(await fillCardCounters(e)).toEqual({ changed: 1, more: false });
		expect(db.raw.prepare("SELECT counter_account_id FROM lines WHERE id = 'pay'").get()).toEqual({ counter_account_id: CARD_A.id });
		expect(db.raw.prepare("SELECT actor, event FROM line_events WHERE line_id = 'pay'").all()).toEqual([{ actor: "rules", event: "fill_card_counter" }]);
		expect(await fillCardCounters(e)).toEqual({ changed: 0, more: false });
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM line_events WHERE line_id = 'pay'").get()).toEqual({ n: 1 });
	});

	it("never touches a counter account the owner set, nor one that is already a card", async () => {
		await put(db, "lines", payment({ id: "owners", counter_account_id: "cash" }));
		db.raw
			.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) VALUES ('owners', '2026-10-01T00:00:00.000Z', 'owner', 'kind', '{}', ?)")
			.run(JSON.stringify({ kind: "card_payment", counter_account_id: "cash" }));
		await put(db, "lines", payment({ id: "set", merchant_raw: "Other bank's card ending 2222", counter_account_id: CARD_A.id }));
		expect(await fillCardCounters(testEngine(db))).toEqual({ changed: 0, more: false });
		expect(db.raw.prepare("SELECT id, counter_account_id FROM lines ORDER BY id").all()).toEqual([
			{ id: "owners", counter_account_id: "cash" },
			{ id: "set", counter_account_id: CARD_A.id },
		]);
	});
});
