/// A card purchase the owner tells the ledger himself (21 Oct 2026): a
/// small Apple Pay on his Citi card, under Citi's alert threshold, on a day
/// his Apple Pay Shortcut was failing — so no alert and no tap ever came. His
/// word makes the line on THAT card, so that when the card's statement (or a
/// late alert or tap) brings the same purchase it joins this line instead of
/// making a second one. MADE-UP amounts and merchants.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCash, ingestEvidence, ingestStatement, type EvidenceIn } from "../src/engine";
import type { Actor, LineRow } from "../src/types";
import { totals } from "../src/views";
import { BANK, CARD_A, CARD_C, CARD_T, CASH } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, addRate, testEngine } from "./helpers/world";

/// An engine whose ids never repeat another's in the same test.
let engines = 0;
const eng = (actor: Actor = "rules") => {
	const k = ++engines;
	let n = 0;
	return { ...testEngine(db, actor), newId: () => `e${k}-${++n}` };
};

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
});
afterEach(() => db.close());

const lines = () => db.raw.prepare("SELECT * FROM lines ORDER BY created_at, id").all() as unknown as LineRow[];
const live = () => lines().filter((l) => l.state !== "void" && l.merged_into === null);
const typesOf = (id: string) => (db.raw.prepare("SELECT type FROM evidence WHERE line_id = ? ORDER BY type").all(id) as { type: string }[]).map((r) => r.type);

/// The owner: "I paid S$6.80 at a bakery by Apple Pay on my Citi card on the 20th."
const told = (over: Partial<Parameters<typeof addCash>[1]> = {}) =>
	addCash(eng("owner"), { account_id: CARD_C.id, txn_date: "2026-10-20", currency: "SGD", amount_minor: 680, merchant: "Bakery", category: "Food", ...over });

describe("a card purchase on the owner's word", () => {
	it("is a provisional line on that card, in his category, marked as added by him", async () => {
		const line = await told();
		expect(line).toMatchObject({
			account_id: CARD_C.id,
			kind: "purchase",
			state: "open",
			orig_currency: "SGD",
			orig_minor: 680,
			bill_currency: "SGD",
			bill_minor: 680,
			home_minor: 680,
			category: "Food",
			statement_id: null,
			created_by: "owner",
		});
		// His word is the line's only evidence, of the kind the page shows as 「你手動加的」.
		expect(typesOf(line.id)).toEqual(["manual"]);
		expect(totals(lines()).spending_home.minor).toBe(680);
	});

	it("is joined by the card's statement line for the same purchase: one line, confirmed, counted once", async () => {
		const line = await told();
		const s = await ingestStatement(eng(), { account_id: CARD_C.id, period_start: "2026-10-01", period_end: "2026-10-31", currency: "SGD", opening_balance_minor: 0, closing_balance_minor: 680, printed_net_minor: null }, [
			{ seq: 1, txn_date: "2026-10-20", post_date: "2026-10-21", currency: "SGD", amount_minor: 680, merchant_raw: "BAKERY PTE LTD SINGAPORE SG", kind_hint: "purchase" },
		]);
		expect(s.status === "imported" && s.created.length === 0 && s.attached.length === 1 && s.recon.ok).toBe(true);
		expect(live().map((l) => l.id)).toEqual([line.id]);
		expect(typesOf(line.id)).toEqual(["manual", "statement_line"]);
		// No longer provisional; his category stays; S$6.80, not S$13.60.
		expect(live()[0]).toMatchObject({ statement_id: (s as { statement_id: string }).statement_id, category: "Food", home_minor: 680, flag_not_on_statement: 0 });
		expect(totals(lines()).spending_home.minor).toBe(680);
	});

	it("joins the line an alert (or tap) already made for that card, day and amount, instead of adding one", async () => {
		const r = await ingestEvidence(eng(), citiAlert("c1"));
		const alerted = (r as { line_id: string }).line_id;
		const line = await told({ txn_date: "2026-10-20" });
		expect(line.id).toBe(alerted);
		expect(line.created_by).toBe("rules"); // the connector reads this as already_recorded
		expect(live()).toHaveLength(1);
		expect(typesOf(alerted)).toEqual(["alert", "manual"]);
		// His category is his word; the amount stays the bank's.
		expect(live()[0]).toMatchObject({ category: "Food", home_minor: 680 });
		expect(totals(lines()).spending_home.minor).toBe(680);
		// The statement still joins that one line afterwards.
		const s = await ingestStatement(eng(), { account_id: CARD_C.id, period_start: "2026-10-01", period_end: "2026-10-31", currency: "SGD", opening_balance_minor: 0, closing_balance_minor: 680, printed_net_minor: null }, [
			{ seq: 1, txn_date: "2026-10-20", currency: "SGD", amount_minor: 680, merchant_raw: "BAKERY PTE LTD", kind_hint: "purchase" },
		]);
		expect(s.status === "imported" && s.created.length === 0).toBe(true);
		expect(live()).toHaveLength(1);
	});

	it("a late alert for the same purchase joins his line", async () => {
		const line = await told();
		expect(await ingestEvidence(eng(), citiAlert("c2"))).toMatchObject({ status: "attached", line_id: line.id });
		expect(live()).toHaveLength(1);
		expect(totals(lines()).spending_home.minor).toBe(680);
	});

	it("a different card, day or amount is a purchase of its own", async () => {
		await ingestEvidence(eng(), citiAlert("c3", { amount_minor: 690 }));
		await ingestEvidence(eng(), citiAlert("c4", { txn_date: "2026-10-17" }));
		await ingestEvidence(eng(), citiAlert("c5", { institution: "hsbc", last4: "1111" }));
		const line = await told();
		expect(line.created_by).toBe("owner");
		expect(typesOf(line.id)).toEqual(["manual"]);
		expect(live()).toHaveLength(4);
	});
});

describe("what his word on a card can and cannot be", () => {
	it("a purchase in another currency is an estimate until the statement prints what was billed", async () => {
		// JPY 1,200 × 0.009 = SGD 10.80 at market, plus the card's markup: an estimate.
		await addRate(db, "2026-10-20", "JPY", 0.009);
		const line = await told({ currency: "JPY", amount_minor: 1200, merchant: "Ramen" });
		expect(line).toMatchObject({ orig_currency: "JPY", orig_minor: 1200, bill_currency: "SGD", bill_status: "estimate", statement_id: null });
		expect(line.bill_minor).toBeGreaterThanOrEqual(1080);
		// The statement prints only the SGD it billed (S$11.12): within the estimate's tolerance, it joins and confirms.
		const s = await ingestStatement(eng(), { account_id: CARD_C.id, period_start: "2026-10-01", period_end: "2026-10-31", currency: "SGD", opening_balance_minor: 0, closing_balance_minor: 1112, printed_net_minor: null }, [
			{ seq: 1, txn_date: "2026-10-20", currency: "SGD", amount_minor: 1112, merchant_raw: "RAMEN TOKYO JP", kind_hint: "purchase" },
		]);
		expect(s.status === "imported" && s.created.length === 0).toBe(true);
		expect(live()).toHaveLength(1);
		expect(live()[0]).toMatchObject({ id: line.id, bill_minor: 1112, bill_status: "confirmed", home_minor: 1112 });
	});

	it("on 台新 (no alerts, statement only) it is provisional too, and its statement joins it", async () => {
		const line = await told({ account_id: CARD_T.id, currency: "TWD", amount_minor: 15000, merchant: "Night market" });
		expect(line).toMatchObject({ account_id: CARD_T.id, bill_currency: "TWD", bill_minor: 15000, statement_id: null, created_by: "owner" });
		const s = await ingestStatement(eng(), { account_id: CARD_T.id, period_start: "2026-10-01", period_end: "2026-10-31", currency: "TWD", opening_balance_minor: 0, closing_balance_minor: 15000, printed_net_minor: null }, [
			{ seq: 1, txn_date: "2026-10-21", currency: "TWD", amount_minor: 15000, merchant_raw: "NIGHT MARKET TAIPEI", kind_hint: "purchase" },
		]);
		expect(s.status === "imported" && s.created.length === 0).toBe(true);
		expect(live().map((l) => l.id)).toEqual([line.id]);
	});

	it("an SGD figure is refused on a card: its statement confirms what it cost", async () => {
		await expect(told({ currency: "JPY", amount_minor: 1200, home_minor: 1100 })).rejects.toThrow(/statement confirms/);
		expect(lines()).toHaveLength(0);
	});

	it("a bank account is still refused: its lines come from its alerts and statements", async () => {
		await expect(told({ account_id: BANK.id })).rejects.toThrow(/bank account/);
		expect(lines()).toHaveLength(0);
	});

	it("two different purchases that both fit: refused with the two, nothing added", async () => {
		await ingestEvidence(eng(), citiAlert("d1", { merchant_raw: "SHOE SHOP" }));
		await ingestEvidence(eng(), citiAlert("d2", { merchant_raw: "FLORIST" }));
		await expect(told({ merchant: "Bakery" })).rejects.toThrow(/2 .* lines of that amount/);
		expect(live()).toHaveLength(2);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM evidence WHERE type = 'manual'").get()).toEqual({ n: 0 });
	});

	it("cash stays cash: a cash line never joins a card line, and is counted on its own", async () => {
		await ingestEvidence(eng(), citiAlert("e1"));
		const cash = await told({ account_id: CASH.id });
		expect(cash.account_id).toBe(CASH.id);
		expect(live()).toHaveLength(2);
		expect(totals(lines()).spending_home.minor).toBe(1360);
		// A card the owner did not name is untouched.
		expect(live().filter((l) => l.account_id === CARD_A.id)).toHaveLength(0);
	});
});

const citiAlert = (fp: string, over: Partial<EvidenceIn> = {}): EvidenceIn => ({
	type: "alert",
	institution: "citi",
	last4: CARD_C.last4,
	fingerprint: fp,
	txn_date: "2026-10-20",
	txn_time: "12:31",
	currency: "SGD",
	amount_minor: 680,
	merchant_raw: "BAKERY PTE LTD",
	kind_hint: "purchase",
	authenticated: true,
	...over,
});
