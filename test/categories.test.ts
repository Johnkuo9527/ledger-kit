/// The playbook's category rules, filled into lines (src/engine.ts applyCategoryRules).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCategoryRules, enforceOwnerRules, setLineCategory, type Engine } from "../src/engine";
import { line } from "./helpers/fixtures";
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

const cat = async (id: string) => (await db.prepare("SELECT category FROM lines WHERE id = ?").bind(id).first<{ category: string | null }>())!.category;

describe("category rules", () => {
	it("fill every empty category their merchant has, and log each change", async () => {
		await put(db, "lines", line({ id: "g1", merchant_key: "GRAB" }));
		await put(db, "lines", line({ id: "g2", merchant_key: "GRAB" }));
		await put(db, "lines", line({ id: "k1", merchant_key: "KOPI CORNER" }));
		await put(db, "lines", line({ id: "x1", merchant_key: "UNKNOWN SHOP" }));
		const n = await applyCategoryRules(e, [{ merchant_key: "GRAB", category: "Transport" }, { merchant_key: "KOPI CORNER", category: "Food" }], 100);
		expect(n).toBe(3);
		expect([await cat("g1"), await cat("g2"), await cat("k1"), await cat("x1")]).toEqual(["Transport", "Transport", "Food", null]);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM line_events WHERE event = 'categorise'").bind().first<{ n: number }>())!.n).toBe(3);
		// Nothing left to do: a second call changes nothing.
		expect(await applyCategoryRules(e, [{ merchant_key: "GRAB", category: "Transport" }], 100)).toBe(0);
	});

	it("never overwrite a category already set (the owner's, or an earlier rule's), nor touch a void line", async () => {
		await put(db, "lines", line({ id: "c1", merchant_key: "GRAB", category: "Work travel" }));
		await put(db, "lines", line({ id: "v1", merchant_key: "GRAB", state: "void" }));
		expect(await applyCategoryRules(e, [{ merchant_key: "GRAB", category: "Transport" }], 100)).toBe(0);
		expect([await cat("c1"), await cat("v1")]).toEqual(["Work travel", null]);
	});

	it("a rule for one kind applies to that kind only; the limit is a batch, the rest come next call", async () => {
		await put(db, "lines", line({ id: "p1", merchant_key: "APPLE", kind: "purchase" }));
		await put(db, "lines", line({ id: "r1", merchant_key: "APPLE", kind: "refund" }));
		expect(await applyCategoryRules(e, [{ merchant_key: "APPLE", category: "Subscriptions", kind: "purchase" }], 100)).toBe(1);
		expect([await cat("p1"), await cat("r1")]).toEqual(["Subscriptions", null]);

		for (let i = 0; i < 5; i++) await put(db, "lines", line({ id: `m${i}`, merchant_key: "MRT" }));
		const rules = [{ merchant_key: "MRT", category: "Transport" }];
		expect(await applyCategoryRules(e, rules, 3)).toBe(3);
		expect(await applyCategoryRules(e, rules, 3)).toBe(2);
	});

	it("more merchants than one statement may bind (D1: 100) are asked in slices", async () => {
		const rules = Array.from({ length: 200 }, (_, i) => ({ merchant_key: `SHOP ${i}`, category: "Shopping" }));
		await put(db, "lines", line({ id: "s199", merchant_key: "SHOP 199" }));
		expect(await applyCategoryRules(e, rules, 100)).toBe(1);
		expect(await cat("s199")).toBe("Shopping");
	});

	it("The owner's rule moves a model-placed line, but never a line he categorised himself", async () => {
		await put(db, "lines", line({ id: "a", merchant_key: "GRAB", category: "Transportation" }));
		await put(db, "lines", line({ id: "b", merchant_key: "GRAB" }));
		await put(db, "lines", line({ id: "c", merchant_key: "GRAB" }));
		await put(db, "lines", line({ id: "d", merchant_key: "GRAB", category: "Grab/Uber" }));
		await setLineCategory(e, "c", "Social");
		const owner = [{ merchant_key: "GRAB", category: "Grab/Uber" }];
		expect(await enforceOwnerRules({ ...e, actor: "owner" }, owner, 100)).toBe(2);
		expect([await cat("a"), await cat("b"), await cat("c"), await cat("d")]).toEqual(["Grab/Uber", "Grab/Uber", "Social", "Grab/Uber"]);
		expect(await enforceOwnerRules({ ...e, actor: "owner" }, owner, 100)).toBe(0);
		const ev = await db.prepare("SELECT actor, event FROM line_events WHERE line_id = 'c'").bind().all();
		expect(ev.results).toEqual([{ actor: "owner", event: "category" }]);
	});
});
