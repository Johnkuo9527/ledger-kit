/// The GrabPay wallet (14 Oct 2026), end to end on the real migration.
/// Every account, merchant and amount is MADE UP; every expected figure was
/// worked out by hand in the comments first.
///
/// The made-up wallet: recorded from 2026-10-14 with S$42.00 in it, all of it
/// already counted as spending when it was topped up (category Grab/Uber).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../src/db";
import { addCash, getLine, ingestEvidence, ingestStatement, markWalletTopUp, reviewLine, setLineKind, type Engine, type EvidenceIn } from "../src/engine";
import { groupTotals, lineViews, needsOk, coverageFor, loadAccountMap } from "../src/queries";
import type { LineRow } from "../src/types";
import { totals } from "../src/views";
import { isDirectGrabCharge, looksLikeTopUp, planOffsets, walletStates, type WalletAccount } from "../src/wallet";
import { BANK, CARD_A, WALLET } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, testEngine, WORLD_ACCOUNTS } from "./helpers/world";

let db: TestDb;
let e: Engine;
const W = WALLET as WalletAccount;

beforeEach(async () => {
	db = freshDb();
	await addAccounts(db, WORLD_ACCOUNTS);
	await insertRow(db, "accounts", WALLET).run();
	e = testEngine(db);
});
afterEach(() => db.close());

const all = async () => (await db.prepare("SELECT * FROM lines WHERE state <> 'void'").bind().all<LineRow>()).results;
const spending = async () => totals(await all()).spending_home.minor;
const state = async () => (await walletStates(db, [WALLET])).get(W.id)!;
let fp = 0;
const bankAlert = (merchant: string, amount: number, date: string, over: Partial<EvidenceIn> = {}): EvidenceIn => ({
	type: "alert",
	institution: "dbs",
	last4: BANK.last4,
	authenticated: true,
	fingerprint: `bank-${++fp}`,
	txn_date: date,
	currency: "SGD",
	amount_minor: amount,
	merchant_raw: merchant,
	kind_hint: "purchase",
	...over,
});
const cardAlert = (merchant: string, amount: number, date: string): EvidenceIn => ({ ...bankAlert(merchant, amount, date), institution: "hsbc", last4: CARD_A.last4 });
const spend = (amount: number, date: string, merchant: string, category: string) => addCash(e, { account_id: W.id, txn_date: date, currency: "SGD", amount_minor: amount, merchant, category });

describe("the rules, on their own", () => {
	it("first in, first out: the pre-counted S$42.00 covers 5.44 + 30.00 + 6.56 of the 10.00 (4200 − 544 − 3000 = 656)", () => {
		const l = (id: string, date: string, cents: number, kind: LineRow["kind"] = "purchase") => ({ id, kind, state: "open" as const, txn_date: date, created_at: `${date}T00:00:00Z`, home_minor: cents, merged_into: null });
		const plan = planOffsets(4200, "2026-10-14", [l("c", "2026-10-16", 1000), l("a", "2026-10-14", 544), l("b", "2026-10-15", 3000), l("r", "2026-10-15", -300, "refund"), l("old", "2026-10-13", 999)]);
		expect([...plan]).toEqual([
			["a", 544],
			["b", 3000],
			["c", 656],
		]);
	});

	it("tells a top-up from a direct Grab payment", () => {
		const bank = { kind: "bank" as const };
		const card = { kind: "credit_card" as const };
		expect(looksLikeTopUp(bank, "GRAB", 2000, "2026-10-15", W)).toBe(true); // round, on the DBS account
		expect(looksLikeTopUp(bank, "Grab Singapore", 5000, "2026-10-15", W)).toBe(true);
		expect(looksLikeTopUp(bank, "GRAB", 1234, "2026-10-15", W)).toBe(false); // odd amount: spending
		expect(looksLikeTopUp(bank, "GRAB", 2000, "2026-10-13", W)).toBe(false); // before the cut-over: stays spending
		expect(looksLikeTopUp(card, "GRAB", 2000, "2026-10-15", W)).toBe(false); // a card line needs the word top-up
		expect(looksLikeTopUp(card, "GRAB* A-7F3K2 SINGAPORE SG", 2000, "2026-10-15", W)).toBe(false); // a ride paid by card
		expect(looksLikeTopUp(card, "GRABPAY TOP UP", 3000, "2026-10-15", W)).toBe(true);
		expect(looksLikeTopUp(bank, "GRABFOOD", 2000, "2026-10-15", W)).toBe(false);
		expect(isDirectGrabCharge("Grab* 2-4ABCD")).toBe(true);
		expect(isDirectGrabCharge("GRAB")).toBe(false);
	});
});

describe("a top-up is a transfer to his own wallet, never spending", () => {
	it("S$20 from the DBS account to GRAB after the cut-over: a transfer, the wallet goes up by S$20 (4200 + 2000 = 6200)", async () => {
		const r = await ingestEvidence(e, bankAlert("GRAB", 2000, "2026-10-15"));
		expect(r.status).toBe("created");
		const bank = (await getLine(db, (r as { line_id: string }).line_id))!;
		expect(bank).toMatchObject({ kind: "transfer", counter_account_id: W.id });
		const legs = (await all()).filter((l) => l.account_id === W.id);
		expect(legs).toHaveLength(1);
		expect(legs[0]).toMatchObject({ kind: "transfer", bill_minor: -2000, transfer_group: bank.transfer_group, counter_account_id: BANK.id });
		expect(bank.transfer_group).not.toBeNull();
		expect(await spending()).toBe(0);
		expect((await state()).balance.minor).toBe(6200);
	});

	it("before the cut-over, an odd amount, or a ride paid by card: spending, as before", async () => {
		await ingestEvidence(e, bankAlert("GRAB", 2000, "2026-10-10")); // pre-cut-over top-up: the owner chose not to backfill
		await ingestEvidence(e, bankAlert("GRAB", 1234, "2026-10-15"));
		await ingestEvidence(e, cardAlert("GRAB* A-7F3K2 SINGAPORE SG", 2000, "2026-10-15"));
		expect((await all()).map((l) => l.kind)).toEqual(["purchase", "purchase", "purchase"]);
		expect(await spending()).toBe(2000 + 1234 + 2000);
		expect((await state()).balance.minor).toBe(4200);
	});

	it("a card line that says top-up is one too", async () => {
		await ingestEvidence(e, cardAlert("GRABPAY TOP UP", 3000, "2026-10-16"));
		expect(await spending()).toBe(0);
		expect((await state()).balance.minor).toBe(4200 + 3000);
	});

	it("the wallet's statement reports a top-up first; the card's Grab charge of that amount then becomes it — never a ride with a booking code", async () => {
		const st = await ingestStatement(e, walletStatement("2026-10-16", 4200, 4200 + 2500), [{ seq: 1, txn_date: "2026-10-16", currency: "SGD", amount_minor: -2500, merchant_raw: "Top up", kind_hint: "transfer" }]);
		expect(st.status).toBe("imported");
		const ride = await ingestEvidence(e, cardAlert("GRAB* A-99ZZ SINGAPORE SG", 2500, "2026-10-16"));
		expect((await getLine(db, (ride as { line_id: string }).line_id))!.kind).toBe("purchase");
		const card = await ingestEvidence(e, cardAlert("GRAB SINGAPORE", 2500, "2026-10-16"));
		const line = (await getLine(db, (card as { line_id: string }).line_id))!;
		expect(line).toMatchObject({ kind: "transfer", counter_account_id: W.id });
		expect(line.transfer_group).not.toBeNull();
		// Only the ride counts: 25.00.
		expect(await spending()).toBe(2500);
		expect((await state()).balance.minor).toBe(4200 + 2500);
	});

	it("The owner's word: this bank line was a top-up; and taking it back removes the wallet's side again", async () => {
		const r = await ingestEvidence(e, bankAlert("GRAB", 1234, "2026-10-15")); // odd amount: read as spending
		const id = (r as { line_id: string }).line_id;
		await markWalletTopUp(e, id);
		expect(await getLine(db, id)).toMatchObject({ kind: "transfer", counter_account_id: W.id });
		expect((await state()).balance.minor).toBe(4200 + 1234);
		expect(await spending()).toBe(0);
		await setLineKind(e, id, "purchase");
		expect((await state()).balance.minor).toBe(4200);
		expect(await spending()).toBe(1234);
	});
});

describe("the balance already counted at top-up is never counted twice", () => {
	it("today's S$5.44 drink: in Drinks, offset in Grab/Uber, the total unchanged; S$36.56 left in the wallet", async () => {
		const drink = await spend(544, "2026-10-14", "GrabFood - Test Tea", "Drinks");
		expect(drink).toMatchObject({ account_id: W.id, kind: "purchase", category: "Drinks", home_minor: 544 });
		const lines = await all();
		const offset = lines.find((l) => l.kind === "wallet_offset")!;
		expect(offset).toMatchObject({ offset_of: drink.id, home_minor: -544, category: "Grab/Uber", txn_date: "2026-10-14" });
		expect(await spending()).toBe(0);
		const accounts = await loadAccountMap(db);
		const groups = new Map(groupTotals(lines, "category", accounts).map((g) => [g.key, g.spending_home.minor]));
		expect(groups.get("Drinks")).toBe(544);
		expect(groups.get("Grab/Uber")).toBe(-544);
		const s = await state();
		expect(s.balance.minor).toBe(3656);
		expect(s.precounted_left.minor).toBe(3656);
		// Visible on the line itself.
		const [view] = await lineViews(db, [drink]);
		expect(view!.wallet).toMatchObject({ precounted: { minor: 544 }, offset_line_id: offset.id });
		expect(view!.wallet!.message).toContain("儲值時已算過");
		expect(view!.provisional).toBe(true); // until GrabPay's statement confirms it
	});

	it("after S$42.00 is used up, wallet spending counts: 5.44 + 30.00 offset in full, 10.00 counts 3.44, 5.00 counts in full", async () => {
		await spend(544, "2026-10-14", "GrabFood - Test Tea", "Drinks");
		await spend(3000, "2026-10-15", "GrabFood - Test Noodles", "Food");
		expect(await spending()).toBe(0);
		await spend(1000, "2026-10-16", "GrabCar", "Grab/Uber");
		// 4200 − 544 − 3000 = 656 of the 10.00 is pre-counted; 1000 − 656 = 344 counts.
		expect(await spending()).toBe(344);
		await spend(500, "2026-10-17", "GrabMart - Test Shop", "Supermarket");
		expect(await spending()).toBe(344 + 500);
		expect((await state()).precounted_left.minor).toBe(0);
		expect((await state()).balance.minor).toBe(4200 - 544 - 3000 - 1000 - 500);
	});

	it("a purchase removed gives its share back, first in first out again", async () => {
		await spend(544, "2026-10-14", "GrabFood - Test Tea", "Drinks");
		const noodles = await spend(3000, "2026-10-15", "GrabFood - Test Noodles", "Food");
		const ride = await spend(1000, "2026-10-16", "GrabCar", "Grab/Uber");
		expect(await spending()).toBe(344);
		await reviewLine(e, noodles.id, "void");
		// 544 + 1000 now both fit inside 4200: nothing counts.
		expect(await spending()).toBe(0);
		const offsetOfRide = (await all()).find((l) => l.offset_of === ride.id)!;
		expect(offsetOfRide.home_minor).toBe(-1000);
		// An offset line is the ledger's own: the owner changes the purchase, not it.
		await expect(reviewLine(e, offsetOfRide.id, "void")).rejects.toThrow(/offset/);
		await expect(setLineKind(e, offsetOfRide.id, "transfer")).rejects.toThrow(/offset/);
	});

	it("spending from before the cut-over cannot be added to the wallet; and the wallet holds SGD only", async () => {
		await expect(spend(500, "2026-10-13", "GrabFood", "Food")).rejects.toThrow(/2026-10-14/);
		await expect(addCash(e, { account_id: W.id, txn_date: "2026-10-15", currency: "MYR", amount_minor: 500, merchant: "Grab" })).rejects.toThrow(/SGD/);
		await expect(addCash(e, { account_id: BANK.id, txn_date: "2026-10-15", currency: "SGD", amount_minor: 500, merchant: "x" })).rejects.toThrow(/bank account/);
	});

	it("The owner's word for a purchase Grab's own e-receipt already recorded joins that line instead of adding a second", async () => {
		const r = await ingestEvidence(e, { type: "alert", account_id: W.id, institution: "grab", authenticated: true, fingerprint: "grab-1", txn_date: "2026-10-14", currency: "SGD", amount_minor: 544, merchant_raw: "Test Tea", kind_hint: "purchase", category: "Drinks" });
		expect(r.status).toBe("created");
		const joined = await spend(544, "2026-10-14", "GrabFood - Test Tea", "Drinks");
		expect(joined.id).toBe((r as { line_id: string }).line_id);
		expect((await all()).filter((l) => l.kind === "purchase")).toHaveLength(1);
		expect(await spending()).toBe(0);
	});

	it("and the other way round: Grab's e-receipt arriving after the owner's word joins his line", async () => {
		const mine = await spend(544, "2026-10-14", "GrabFood - Test Tea", "Drinks");
		const r = await ingestEvidence(e, { type: "alert", account_id: W.id, institution: "grab", authenticated: true, fingerprint: "grab-2", txn_date: "2026-10-14", currency: "SGD", amount_minor: 544, merchant_raw: "Test Tea", kind_hint: "purchase", category: "Food" });
		expect(r).toMatchObject({ status: "attached", line_id: mine.id });
		expect((await getLine(db, mine.id))!.category).toBe("Drinks"); // the owner's word stands
		expect(await spending()).toBe(0);
	});
});

function walletStatement(day: string, opening: number | null, closing: number | null) {
	return { account_id: W.id, period_start: day, period_end: day, currency: "SGD", opening_balance_minor: opening, closing_balance_minor: closing, printed_net_minor: null };
}

describe("GrabPay's statement reconciles the wallet to the cent", () => {
	it("opening 42.00 − 5.44 = closing 36.56: the drink the owner recorded is confirmed, the day reconciles", async () => {
		const drink = await spend(544, "2026-10-14", "GrabFood - Test Tea", "Drinks");
		const r = await ingestStatement(e, walletStatement("2026-10-14", 4200, 3656), [{ seq: 1, txn_date: "2026-10-14", currency: "SGD", amount_minor: 544, merchant_raw: "GrabFood Test Tea", kind_hint: "purchase" }]);
		expect(r.status).toBe("imported");
		if (r.status !== "imported") return;
		expect(r.attached).toEqual([drink.id]);
		expect(r.recon.ok).toBe(true);
		expect(r.recon.rule).toBe("wallet_balance");
		const [view] = await lineViews(db, [(await getLine(db, drink.id))!]);
		expect(view!.provisional).toBe(false);
		expect(await spending()).toBe(0); // the statement changes nothing about the offset
	});

	it("a day that does not add up is a 待確認 item with the same actions as every other month", async () => {
		await spend(544, "2026-10-14", "GrabFood - Test Tea", "Drinks");
		// Printed: opening 36.56, one 4.00 ride, closing 30.00 — 36.56 − 4.00 = 32.56, not 30.00.
		const r = await ingestStatement(e, walletStatement("2026-10-15", 3656, 3000), [{ seq: 1, txn_date: "2026-10-15", currency: "SGD", amount_minor: 400, merchant_raw: "GrabCar", kind_hint: "purchase" }]);
		if (r.status !== "imported") throw new Error(r.status);
		expect(r.recon.ok).toBe(false);
		const codes = r.recon.problems.map((p) => p.code);
		expect(codes).toContain("statement_lines_mismatch");
		// The ledger: 4200 − 544 − 400 = 3256 at the end of the 15th; printed 3000.
		expect(codes).toContain("wallet_balance_mismatch");
		const ok = await needsOk(db);
		const month = ok.months.find((m) => m.account_id === W.id)!;
		expect(month.status).toBe("escalated");
		expect(month.actions.map((a) => a.id)).toEqual(["reviewed", "recheck"]);
	});

	it("coverage says from when the wallet is recorded, and its balance", async () => {
		await spend(544, "2026-10-14", "GrabFood - Test Tea", "Drinks");
		const cov = (await coverageFor(db, (await loadAccountMap(db)).values(), "2026-10-14")).find((c) => c.account_id === W.id)!;
		expect(cov).toMatchObject({ mode: "wallet", partial: false, wallet: { since: "2026-10-14", balance: { minor: 3656 } } });
		expect(cov.message).toContain("從 2026-10-14 起記錄；之前的儲值已算作支出");
	});
});
