/// Categories: the owner's own list, merchants sorted into it, rules filled into
/// lines, and the owner's word over any model's.

import { EXAMPLE_BANKS as BANKS } from "./helpers/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { line } from "../../test/helpers/fixtures";
import { addAccounts, put } from "../../test/helpers/world";
import { emptyPlaybook } from "../../src/playbook";
import { publishPlaybook, readHead } from "../../src/playbook-store";
import { categorise, constrainToList, sortMerchants } from "../src/categorise";
import { applyEdits } from "../src/escalate";
import { editCategoriesOp, incomeOffsetOp, makeOp, pickCategoryOp, setCategoryOp } from "../src/ops";
import { runTick } from "../src/tick";
import { FakeClaude, MODELS } from "./helpers/fake-claude";
import { makeDeps, makeEnv } from "./helpers/harness";

const LIST = "Food, Transportation, Grab/Uber, Others";

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
beforeEach(async () => {
	db = freshDb();
	D = makeDeps();
	await addAccounts(db);
});
afterEach(() => db.close());

const env = (over: Record<string, string> = {}) => makeEnv(db, { ...MODELS, LEDGER_CATEGORIES: LIST, ...over });
const tick = (claude?: FakeClaude, over: Record<string, string> = {}) => runTick(env(over), D, claude ? { claude } : {}, [sortMerchants, categorise]);
const categories = () => Object.fromEntries((db.raw.prepare("SELECT id, category FROM lines ORDER BY id").all() as { id: string; category: string | null }[]).map((r) => [r.id, r.category]));
const rules = async () => (await readHead(db))?.body.category_rules ?? [];

async function seedPlaybook(categoryRules: { merchant_key: string; category: string; by?: "owner" }[] = [], cats: string[] = []) {
	const book = emptyPlaybook();
	book.categories = [...new Set([...cats, ...categoryRules.map((r) => r.category)])];
	book.category_rules = categoryRules;
	await publishPlaybook(db, book, null, "senior", "test", "2026-10-01T00:00:00.000Z");
}

describe("sorting merchants into the owner's list", () => {
	it("a merchant the reader left out goes to 其他 when that is the owner's catch-all (a Traditional Chinese list)", async () => {
		await put(db, "lines", line({ id: "a", merchant_key: "KOPI CORNER" }));
		await put(db, "lines", line({ id: "c", merchant_key: "ODD SHOP" }));
		const claude = new FakeClaude(() => ({ rules: [{ merchant_key: "KOPI CORNER", category: "餐飲", is_person: false }] }));
		await tick(claude, { LEDGER_CATEGORIES: "餐飲, 交通, 其他" });
		// KOPI CORNER as answered; ODD SHOP was left out, so it takes the catch-all 其他 ("Others" in English).
		expect(categories()).toEqual({ a: "餐飲", c: "其他" });
	});
	it("asks the senior reader once for the unsorted merchants; its answers become rules and the lines fill", async () => {
		await put(db, "lines", line({ id: "a", merchant_key: "GRAB", merchant_raw: "Grab* A-9QP4" }));
		await put(db, "lines", line({ id: "b", merchant_key: "KOPI CORNER" }));
		await put(db, "lines", line({ id: "c", merchant_key: "ODD SHOP" }));
		await put(db, "lines", line({ id: "p", merchant_key: "DBS VISA DIRECT", kind: "card_payment" })); // not spending: never sorted
		const claude = new FakeClaude(() => ({ rules: [{ merchant_key: "GRAB", category: "Grab/Uber", is_person: false }, { merchant_key: "KOPI CORNER", category: "Food", is_person: false }, { merchant_key: "MADE UP", category: "Food", is_person: false }] }));
		const r = await tick(claude);
		expect(claude.calls).toHaveLength(1);
		expect(claude.calls[0]!.model).toBe("claude-opus-5-5");
		expect(claude.calls[0]!.user).toContain("Food, Transportation, Grab/Uber, Others");
		expect(claude.calls[0]!.user).not.toContain("DBS VISA DIRECT");
		expect(r.counts.merchants_sorted).toBe(3); // ODD SHOP was left out → Others; MADE UP was never asked → dropped
		expect((await rules()).map((x) => [x.merchant_key, x.category])).toEqual([["GRAB", "Grab/Uber"], ["KOPI CORNER", "Food"], ["ODD SHOP", "Others"]]);
		expect(categories()).toEqual({ a: "Grab/Uber", b: "Food", c: "Others", p: null });
		// Everything sorted: no further call.
		await tick(claude);
		expect(claude.calls).toHaveLength(1);
	});

	it("a failed reading waits an hour before it is paid for again", async () => {
		await put(db, "lines", line({ id: "a", merchant_key: "GRAB" }));
		const claude = new FakeClaude(() => ({ rules: "not a list" }));
		await tick(claude);
		const n = claude.calls.length;
		await tick(claude);
		expect(claude.calls).toHaveLength(n);
		D.advance(3_600_001);
		await tick(claude);
		expect(claude.calls.length).toBeGreaterThan(n);
	});

	it("does nothing without the owner's list", async () => {
		await put(db, "lines", line({ id: "a", merchant_key: "GRAB" }));
		const claude = new FakeClaude(() => ({ rules: [] }));
		await tick(claude, { LEDGER_CATEGORIES: "" });
		expect(claude.calls).toHaveLength(0);
	});
});

describe("The owner's list holds", () => {
	it("a model's rule outside the list is dropped; the owner's own stays whatever its category", () => {
		const book = emptyPlaybook();
		book.categories = ["Dining", "Food", "Pets"];
		book.category_rules = [{ merchant_key: "A", category: "Dining" }, { merchant_key: "B", category: "Food" }, { merchant_key: "C", category: "Pets", by: "owner" }];
		const held = constrainToList(book, ["Food", "Others"]);
		expect(held.categories).toEqual(["Food", "Others", "Pets"]);
		expect(held.category_rules.map((r) => r.merchant_key)).toEqual(["B", "C"]);
	});

	it("an escalation's rule never replaces a rule the owner set", () => {
		const book = emptyPlaybook();
		book.categories = ["Grab/Uber"];
		book.category_rules = [{ merchant_key: "GRAB", category: "Grab/Uber", by: "owner" }];
		const refused: string[] = [];
		const next = applyEdits(book, { add_senders: [], add_merchant_aliases: [], add_category_rules: [{ merchant_key: "GRAB", category: "Transportation" }], add_own_names: [], notes_append: null }, BANKS, false, (w) => refused.push(w));
		expect(next.category_rules).toEqual([{ merchant_key: "GRAB", category: "Grab/Uber", by: "owner" }]);
		expect(refused).toEqual(["category_rule_owner"]);
	});
});

describe("The owner sets a category (ledger_set_category)", () => {
	const op = () => makeOp(env(), D, "owner");

	it("lists his categories when given nothing", async () => {
		expect(await setCategoryOp(await op(), {})).toEqual({ categories: ["Food", "Transportation", "Grab/Uber", "Others"], changed: [] });
	});

	it("a merchant: his rule, and its lines move — even ones a model's rule had placed — on the next tick", async () => {
		await seedPlaybook([{ merchant_key: "GRAB", category: "Transportation" }]);
		await put(db, "lines", line({ id: "g1", merchant_key: "GRAB", merchant_name: "Grab", category: "Transportation" }));
		await put(db, "lines", line({ id: "g2", merchant_key: "GRAB", merchant_name: "Grab" }));
		const r = await setCategoryOp(await op(), { merchant: "grab", category: "grab/uber" });
		expect(r.changed).toEqual([{ merchant_key: "GRAB", name: "Grab", category: "Grab/Uber", lines: 2 }]);
		expect(await rules()).toEqual([{ merchant_key: "GRAB", category: "Grab/Uber", by: "owner" }]);
		const t = await tick();
		expect(categories()).toEqual({ g1: "Grab/Uber", g2: "Grab/Uber" });
		expect(t.counts.lines_recategorised).toBe(1);
	});

	it("one line: it is his, and his later merchant rule does not move it", async () => {
		await put(db, "lines", line({ id: "x1", merchant_key: "SHOP", merchant_name: "Shop" }));
		await put(db, "lines", line({ id: "x2", merchant_key: "SHOP", merchant_name: "Shop" }));
		const r = await setCategoryOp(await op(), { line_id: "x1", category: "Food" });
		expect(r.line).toMatchObject({ id: "x1", category: "Food" });
		await setCategoryOp(await op(), { merchant: "Shop", category: "Others" });
		await tick();
		expect(categories()).toEqual({ x1: "Food", x2: "Others" });
	});

	it("refuses a category not on his list, an unknown merchant, and a phrase that is too vague", async () => {
		await put(db, "lines", line({ id: "a", merchant_key: "GRAB" }));
		await expect(setCategoryOp(await op(), { merchant: "grab", category: "Pets" })).rejects.toThrow(/not one of your categories/);
		await expect(setCategoryOp(await op(), { merchant: "nowhere", category: "Food" })).rejects.toThrow(/no merchant/);
		for (let i = 0; i < 16; i++) await put(db, "lines", line({ id: `s${i}`, merchant_key: `SHOP ${i}` }));
		await expect(setCategoryOp(await op(), { merchant: "shop", category: "Food" })).rejects.toThrow(/more than 15/);
	});
});

describe("The owner picks on his page, and the ledger learns (POST /api/lines/:id/category)", () => {
	const op = () => makeOp(env(), D, "owner");

	it("a shop: remembered for the payee — its other lines move at once, and future ones follow", async () => {
		await put(db, "lines", line({ id: "f1", merchant_key: "FAIRPRICE", merchant_name: "FairPrice" }));
		await put(db, "lines", line({ id: "f2", merchant_key: "FAIRPRICE", merchant_name: "FairPrice" }));
		const r = await pickCategoryOp(await op(), "f1", { category: "Food" });
		expect(r).toMatchObject({ scope: "merchant", person: false, merchant_name: "FairPrice", others: 0, changed: 2, line: { id: "f1", category: "Food" } });
		expect(await rules()).toEqual([{ merchant_key: "FAIRPRICE", category: "Food", by: "owner" }]);
		await tick();
		expect(categories()).toEqual({ f1: "Food", f2: "Food" });
		// A later pick for the same shop moves the earlier ones too (they follow the rule, not a one-off).
		await pickCategoryOp(await op(), "f2", { category: "Others" });
		await tick();
		expect(categories()).toEqual({ f1: "Others", f2: "Others" });
	});

	it("a person: only that payment, unless the owner says always (scope merchant)", async () => {
		await seedPlaybook([], ["Food", "Others"]);
		const h = await readHead(db);
		await publishPlaybook(db, { ...h!.body, person_keys: ["FAMILY ONE"] }, h!.version, "senior", "test", "2026-10-02T00:00:00.000Z");
		await put(db, "lines", line({ id: "p1", account_id: "bank-x", merchant_key: "FAMILY ONE", merchant_name: "Family One" }));
		await put(db, "lines", line({ id: "p2", account_id: "bank-x", merchant_key: "FAMILY ONE", merchant_name: "Family One" }));
		const r = await pickCategoryOp(await op(), "p1", { category: "Food" });
		expect(r).toMatchObject({ scope: "line", person: true, others: 0 });
		await tick();
		expect(categories()).toEqual({ p1: "Food", p2: null });
		const always = await pickCategoryOp(await op(), "p2", { category: "Others", scope: "merchant" });
		expect(always.scope).toBe("merchant");
		await tick();
		expect(categories()).toEqual({ p1: "Food", p2: "Others" }); // p1 was picked one by one: it stays
	});

	it("'only this one' on a shop changes that line alone", async () => {
		await put(db, "lines", line({ id: "s1", merchant_key: "SHOP" }));
		await put(db, "lines", line({ id: "s2", merchant_key: "SHOP" }));
		expect((await pickCategoryOp(await op(), "s1", { category: "Food", scope: "line" })).scope).toBe("line");
		expect(await rules()).toEqual([]);
	});

	it("the reader's people get no rule and are not asked about again", async () => {
		await put(db, "lines", line({ id: "x", account_id: "bank-x", merchant_key: "FAMILY ONE" }));
		await put(db, "lines", line({ id: "y", merchant_key: "LEE CAFE" })); // on a card: never a person
		const claude = new FakeClaude(() => ({ rules: [{ merchant_key: "FAMILY ONE", category: "Food", is_person: true }, { merchant_key: "LEE CAFE", category: "Food", is_person: true }] }));
		const r = await tick(claude);
		expect(r.counts.payees_are_people).toBe(1);
		expect((await readHead(db))!.body.person_keys).toEqual(["FAMILY ONE"]);
		expect(await rules()).toEqual([{ merchant_key: "LEE CAFE", category: "Food" }]);
		expect(categories()).toEqual({ x: null, y: "Food" });
		await tick(claude);
		expect(claude.calls).toHaveLength(1);
	});
});

describe("The owner's own categories", () => {
	const op = () => makeOp(env(), D, "owner");

	// Until 23 Oct 2026 he could remove only his own, and its lines kept the removed name; the owner asked to
	// delete any category with what uses it moved first (test/category-manage.test.ts has the whole of it).
	it("he adds one; it joins his list, the picker and the sorting; he removes one only once nothing points at it", async () => {
		expect((await editCategoriesOp(await op(), { add: "Travel" })).categories).toEqual(["Food", "Transportation", "Grab/Uber", "Others", "Travel"]);
		expect((await op()).categories).toContain("Travel");
		await put(db, "lines", line({ id: "t1", merchant_key: "KKDAY" }));
		expect((await pickCategoryOp(await op(), "t1", { category: "travel" })).line.category).toBe("Travel");
		const claude = new FakeClaude(() => ({ rules: [] }));
		await put(db, "lines", line({ id: "u1", merchant_key: "UNSORTED" }));
		await tick(claude);
		expect(claude.calls[0]!.user).toContain("Others, Travel");
		await expect(editCategoriesOp(await op(), { add: "food" })).rejects.toThrow(/already/);
		await expect(editCategoriesOp(await op(), { remove: "Travel" })).rejects.toThrow("'Travel' is used by 1 line and 1 rule; say which category they move to (move_to: one of Food, Transportation, Grab/Uber, Others)");
		expect((await editCategoriesOp(await op(), { remove: "Food" })).categories).toEqual(["Transportation", "Grab/Uber", "Others", "Travel"]);
		expect((await editCategoriesOp(await op(), { remove: "Travel", move_to: "Others" })).categories).toEqual(["Transportation", "Grab/Uber", "Others"]);
		expect(categories().t1).toBe("Others");
	});
});

describe("what an income offsets (POST /api/lines/:id/offset)", () => {
	it("a friend's PayNow pays back one dinner; by card id or name; and back to none", async () => {
		await put(db, "lines", line({ id: "dinner", category: "Food", home_minor: 6000 }));
		await put(db, "lines", line({ id: "in", account_id: "bank-x", kind: "income", home_minor: -2000, bill_minor: -2000, orig_minor: -2000 }));
		const o = await makeOp(env(), D, "owner");
		expect((await incomeOffsetOp(o, "in", { to: "line", target_line_id: "dinner" })).line).toMatchObject({ kind: "refund", refund_of: "dinner", category: "Food", income_offset: { to: "line", account_id: "card-a" } });
		expect((await incomeOffsetOp(o, "in", { to: "card", account_id: "card-b" })).line.income_offset).toEqual({ to: "card", account_id: "card-b" });
		expect((await incomeOffsetOp(o, "in", { to: "salary" })).line).toMatchObject({ kind: "income", category: "Salary", income_offset: { to: "salary", account_id: null } });
		expect((await incomeOffsetOp(o, "in", { to: "none" })).line).toMatchObject({ kind: "income", income_offset: null });
	});
});
