/// What an incoming payment offsets (src/engine.ts setIncomeOffset), and the
/// summaries that follow from it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLine, setIncomeOffset, SALARY_CATEGORY, type Engine } from "../src/engine";
import { groupTotals, loadAccountMap, overview } from "../src/queries";
import { totals } from "../src/views";
import { BANK, CARD_A, line } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, put, testEngine } from "./helpers/world";

let db: TestDb;
let e: Engine;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
	e = testEngine(db);
});
afterEach(() => db.close());

const all = async () => (await db.prepare("SELECT * FROM lines").bind().all()).results as unknown as Parameters<typeof totals>[0];

describe("an incoming payment the owner marks", () => {
	beforeEach(async () => {
		await put(db, "lines", line({ id: "dinner", account_id: CARD_A.id, txn_date: "2026-03-05", category: "Food", home_minor: 6000, bill_minor: 6000, orig_minor: 6000 }));
		await put(db, "lines", line({ id: "pay", account_id: BANK.id, kind: "income", txn_date: "2026-03-01", merchant_raw: "ACME PTE LTD", home_minor: -500000, bill_minor: -500000, orig_minor: -500000 }));
		await put(db, "lines", line({ id: "friend", account_id: BANK.id, kind: "income", txn_date: "2026-03-06", merchant_raw: "DAVID NG", home_minor: -2000, bill_minor: -2000, orig_minor: -2000 }));
	});

	it("is not spending until marked; then it pays back one purchase — its category and its card go down", async () => {
		expect(totals(await all()).spending_home.minor).toBe(6000);
		await setIncomeOffset(e, "friend", { to: "line", line_id: "dinner" });
		expect(await getLine(db, "friend")).toMatchObject({ kind: "refund", income_offset: "line", refund_of: "dinner", category: "Food", offset_account_id: CARD_A.id });
		const lines = await all();
		expect(totals(lines).spending_home.minor).toBe(4000);
		const accounts = await loadAccountMap(db);
		expect(groupTotals(lines, "category", accounts).map((g) => [g.key, g.spending_home.minor])).toEqual([["Food", 4000]]);
		expect(groupTotals(lines, "account", accounts).map((g) => [g.key, g.spending_home.minor])).toEqual([[CARD_A.name, 4000]]);
	});

	it("salary is income, never spending; the overview shows it", async () => {
		await setIncomeOffset(e, "pay", { to: "salary" });
		expect(await getLine(db, "pay")).toMatchObject({ kind: "income", income_offset: "salary", category: SALARY_CATEGORY });
		const o = await overview(db, "2026-03", "2026-03-31");
		expect(o.totals.spending_home.minor).toBe(6000);
		expect(o.income).toEqual({ salary_home: expect.objectContaining({ minor: 500000 }), other_home: expect.objectContaining({ minor: 2000 }) });
	});

	it("a card offset lowers that card's spending in the overview; 'none' puts it back", async () => {
		await setIncomeOffset(e, "friend", { to: "card", account_id: CARD_A.id });
		let o = await overview(db, "2026-03", "2026-03-31");
		expect(o.totals.spending_home.minor).toBe(4000);
		expect(o.by_account.map((a) => [a.account_id, a.spending_home.minor])).toEqual([[CARD_A.id, 4000]]);
		await setIncomeOffset(e, "friend", { to: "none" });
		o = await overview(db, "2026-03", "2026-03-31");
		expect(o.totals.spending_home.minor).toBe(6000);
		expect(await getLine(db, "friend")).toMatchObject({ kind: "income", income_offset: null, offset_account_id: null, refund_of: null });
	});

	it("refuses a purchase as the income, a bank account as the card, and an income as the purchase", async () => {
		await expect(setIncomeOffset(e, "dinner", { to: "salary" })).rejects.toThrow(/only money you received/);
		await expect(setIncomeOffset(e, "friend", { to: "card", account_id: BANK.id })).rejects.toThrow(/credit cards/);
		await expect(setIncomeOffset(e, "friend", { to: "line", line_id: "pay" })).rejects.toThrow(/purchase/);
	});
});
