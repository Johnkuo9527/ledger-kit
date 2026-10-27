/// RENAMING AND DELETING A CATEGORY (23 Oct 2026 — the owner: 「現在可以加新的分類 但根本無法改名字 不夠方便
/// 也刪不掉 如果刪掉的分類有牽連到已分類記得提醒使用者然後讓他確定然後在刪除前給新的分類」).
///
/// Everything that names a category follows a rename, in one step: every line, the owner's payee rules, the
/// playbook's merchant → category map (else the reader keeps writing the old name), a wallet's default,
/// the list itself. A delete that would leave anything pointing at the name needs a category to move it to.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyPlaybook } from "../../src/playbook";
import { publishPlaybook, readHead } from "../../src/playbook-store";
import { line, PREPAID, WALLET } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { put } from "../../test/helpers/world";
import { handleRequest, type App } from "../src/app";
import { categorise, sortMerchants } from "../src/categorise";
import { runTick } from "../src/tick";
import { FakeClaude, MODELS } from "./helpers/fake-claude";
import type { LedgerEnv } from "../src/env";
import { CTX, get, json, makeDeps, makeEnv, post, seedWorld, signedIn, TEST_ASSETS, withLikeCap } from "./helpers/harness";

let raw: TestDb;
let env: LedgerEnv;
let app: App & { deps: ReturnType<typeof makeDeps> };
let cookie: string;
const AT = "2026-10-09T00:00:00.000Z";

beforeEach(async () => {
	raw = freshDb();
	await seedWorld(raw);
	env = makeEnv(withLikeCap(raw), { LEDGER_CATEGORIES: "Food, Drinks, Snacks, Others" });
	app = { assets: TEST_ASSETS, deps: makeDeps() };
	cookie = await signedIn();
	const L = (over: Parameters<typeof line>[0]) => put(raw, "lines", line({ account_id: "card-a", txn_date: "2026-10-07", ...over }));
	// Worked by hand: Food = 10.00 + 5.50 = S$15.50 over 2 live lines (the void one is not spending); Drinks S$3.20.
	await L({ id: "f1", merchant_key: "NOODLE BAR", merchant_name: "Noodle Bar", category: "Food", orig_minor: 1000, bill_minor: 1000, home_minor: 1000 });
	await L({ id: "f2", merchant_key: "NOODLE BAR", merchant_name: "Noodle Bar", category: "Food", orig_minor: 550, bill_minor: 550, home_minor: 550 });
	await L({ id: "f3", merchant_key: "RICE SHOP", merchant_name: "Rice Shop", category: "Food", state: "void", orig_minor: 700, bill_minor: 700, home_minor: 700 });
	await L({ id: "d1", merchant_key: "TEA HOUSE", merchant_name: "Tea House", category: "Drinks", orig_minor: 320, bill_minor: 320, home_minor: 320 });
	await put(raw, "payee_rules", { merchant_key: "NOODLE BAR", kind: null, category: "Food", set_by: "owner", updated_at: AT });
	const book = { ...emptyPlaybook(), categories: ["Food", "Drinks", "Snacks", "Others"], category_rules: [{ merchant_key: "RICE SHOP", category: "Food" }, { merchant_key: "NOODLE BAR", category: "Food", by: "owner" as const }, { merchant_key: "TEA HOUSE", category: "Drinks" }] };
	const pub = await publishPlaybook(raw, book, null, "senior", "seed", AT);
	if (!pub.ok) throw new Error("seed playbook");
});
afterEach(() => raw.close());

const send = (r: Request) => handleRequest(r, env, CTX, app);
const getJ = async (path: string) => json(await send(get(path, cookie)));
const postJ = async (path: string, body: object) => json(await send(post(path, body, cookie)));
const cat = (id: string) => (raw.raw.prepare("SELECT category FROM lines WHERE id = ?").get(id) as { category: string | null }).category;
type CatTotal = { category: string; spending_home: { minor: number }; count: number };
const october = async () => {
	const o = (await getJ("/api/overview?month=2026-10")) as unknown as { totals: { spending_home: { minor: number } }; categories: CatTotal[] };
	return { total: o.totals.spending_home.minor, by: Object.fromEntries(o.categories.map((c) => [c.category, c.spending_home.minor])) };
};

describe("renaming a category", () => {
	it("moves every line, the owner's payee rule and the reader's merchant map to the new name, at once", async () => {
		const r = await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
		expect(r.ok).toBe(true);
		expect(r.categories).toEqual(["Eating Out", "Drinks", "Snacks", "Others"]);
		expect((await getJ("/api/categories")).categories).toEqual(["Eating Out", "Drinks", "Snacks", "Others"]);
		expect([cat("f1"), cat("f2"), cat("f3"), cat("d1")]).toEqual(["Eating Out", "Eating Out", "Eating Out", "Drinks"]);
		expect(raw.raw.prepare("SELECT category FROM payee_rules WHERE merchant_key = 'NOODLE BAR'").get()).toEqual({ category: "Eating Out" });
		const head = await readHead(raw);
		expect(head!.body.category_rules).toEqual([{ merchant_key: "RICE SHOP", category: "Eating Out" }, { merchant_key: "NOODLE BAR", category: "Eating Out", by: "owner" }, { merchant_key: "TEA HOUSE", category: "Drinks" }]);
		expect(head!.body.categories).toEqual(["Eating Out", "Drinks", "Snacks", "Others"]);
	});
});

describe("what a rename leaves behind", () => {
	it("each moved line has an event in its history, the owner's word, from the old name to the new", async () => {
		await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
		const ev = raw.raw.prepare("SELECT line_id, actor, event, before_json, after_json FROM line_events WHERE event = 'category_rename' ORDER BY line_id").all();
		expect(ev).toEqual(["f1", "f2", "f3"].map((id) => ({ line_id: id, actor: "owner", event: "category_rename", before_json: '{"category":"Food"}', after_json: '{"category":"Eating Out"}' })));
	});

	it("the month's spending moves with the name, and the month's total does not change", async () => {
		const before = await october();
		expect(before.by.Food).toBe(1550); // worked by hand: 10.00 + 5.50 (the void line is not spending)
		expect(before.by.Drinks).toBe(320);
		await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
		const after = await october();
		expect(after.by.Food).toBeUndefined();
		expect(after.by["Eating Out"]).toBe(1550);
		expect(after.by.Drinks).toBe(320);
		expect(after.total).toBe(before.total);
	});

	it("a wallet's default category follows, so a purchase the owner tells from it lands in the new name", async () => {
		await put(raw, "accounts", { ...PREPAID, wallet_spend_category: "Food" });
		await put(raw, "accounts", { ...WALLET, wallet_precounted_category: "Food" });
		await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
		expect(raw.raw.prepare("SELECT id, wallet_spend_category AS s, wallet_precounted_category AS p FROM accounts WHERE kind = 'wallet' ORDER BY id").all()).toEqual([
			{ id: PREPAID.id, s: "Eating Out", p: PREPAID.wallet_precounted_category },
			{ id: WALLET.id, s: WALLET.wallet_spend_category ?? null, p: "Eating Out" },
		].sort((a, b) => (a.id < b.id ? -1 : 1)));
	});

	it("a renamed starting category remembers the name it started as (the page keeps its icon)", async () => {
		await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
		await postJ("/api/categories", { rename: "Eating Out", to: "Meals" });
		const r = await getJ("/api/categories");
		expect(r.categories).toEqual(["Meals", "Drinks", "Snacks", "Others"]);
		expect(r.was).toEqual({ Meals: "Food" });
	});

	it("only the case changes: allowed, and the lines follow", async () => {
		const r = await postJ("/api/categories", { rename: "food", to: "FOOD" });
		expect(r.ok).toBe(true);
		expect(r.categories).toEqual(["FOOD", "Drinks", "Snacks", "Others"]);
		expect(cat("f1")).toBe("FOOD");
	});
});

describe("a rename onto a name already in the list", () => {
	it("is refused, says how to merge instead, and changes nothing", async () => {
		const r = await postJ("/api/categories", { rename: "Food", to: "drinks" });
		expect(r.ok).toBe(false);
		expect(r.message).toBe("'Drinks' is already one of your categories. To put everything in 'Food' into 'Drinks', delete 'Food' and move it to 'Drinks'");
		expect([cat("f1"), cat("d1")]).toEqual(["Food", "Drinks"]);
		expect((await getJ("/api/categories")).categories).toEqual(["Food", "Drinks", "Snacks", "Others"]);
	});
	it("a name that is not his, or an empty new name, is refused too", async () => {
		expect((await postJ("/api/categories", { rename: "Travel", to: "Trips" })).message).toMatch(/^'Travel' is not one of your categories/);
		expect((await postJ("/api/categories", { rename: "Food", to: "  " })).ok).toBe(false);
		expect((await postJ("/api/categories", { rename: "Food", to: "A, B" })).message).toBe("a category name cannot be empty or contain a comma");
	});
});

const nothingNamed = (name: string) => ({
	lines: (raw.raw.prepare("SELECT COUNT(*) AS n FROM lines WHERE category = ? COLLATE NOCASE").get(name) as { n: number }).n,
	payees: (raw.raw.prepare("SELECT COUNT(*) AS n FROM payee_rules WHERE category = ? COLLATE NOCASE").get(name) as { n: number }).n,
	wallets: (raw.raw.prepare("SELECT COUNT(*) AS n FROM accounts WHERE wallet_spend_category = ? COLLATE NOCASE OR wallet_precounted_category = ? COLLATE NOCASE").get(name, name) as { n: number }).n,
});

describe("deleting a category nothing uses", () => {
	it("simply goes, and stays gone though it is in the starting list (LEDGER_CATEGORIES)", async () => {
		expect((await getJ("/api/categories?usage=1")).usage).toMatchObject({ Snacks: { lines: 0, rules: 0 } });
		const r = await postJ("/api/categories", { delete: "Snacks" });
		expect(r.ok).toBe(true);
		expect(r.categories).toEqual(["Food", "Drinks", "Others"]);
		expect((await getJ("/api/categories")).categories).toEqual(["Food", "Drinks", "Others"]);
		expect((await readHead(raw))!.body.categories).toEqual(["Food", "Drinks", "Others"]);
		expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM line_events WHERE event = 'category_delete'").get()).toEqual({ n: 0 });
	});
	it("the last one cannot go", async () => {
		for (const c of ["Snacks", "Others"]) await postJ("/api/categories", { delete: c });
		await postJ("/api/categories", { delete: "Drinks", move_to: "Food" });
		expect((await postJ("/api/categories", { delete: "Food" })).message).toBe("you need at least one category; add another before deleting this one");
	});
});

describe("deleting a category lines or rules use", () => {
	it("tells how many lines and rules use it, and changes nothing without a category to move them to", async () => {
		const u = (await getJ("/api/categories?usage=1")).usage as Record<string, unknown>;
		// By hand: Food has 2 live lines (f1, f2; f3 is void); rules = merchants NOODLE BAR (payee + playbook) and RICE SHOP.
		expect(u).toEqual({ Food: { lines: 2, rules: 2 }, Drinks: { lines: 1, rules: 1 }, Snacks: { lines: 0, rules: 0 }, Others: { lines: 0, rules: 0 } });
		const r = await postJ("/api/categories", { delete: "Food" });
		expect(r.ok).toBe(false);
		expect(r.message).toBe("'Food' is used by 2 lines and 2 rules; say which category they move to (move_to: one of Drinks, Snacks, Others)");
		expect([cat("f1"), cat("f3")]).toEqual(["Food", "Food"]);
		expect((await getJ("/api/categories")).categories).toEqual(["Food", "Drinks", "Snacks", "Others"]);
	});

	it("an automatic wallet offset is not counted as a line the owner has (lists fold it); it moves with the wallet's default", async () => {
		await put(raw, "accounts", { ...WALLET, wallet_precounted_category: "Food" });
		await put(raw, "lines", line({ id: "off", account_id: WALLET.id, kind: "wallet_offset", txn_date: "2026-10-07", category: "Food", orig_minor: -200, bill_minor: -200, home_minor: -200 }));
		expect(((await getJ("/api/categories?usage=1")).usage as Record<string, unknown>).Food).toEqual({ lines: 2, rules: 3 }); // + the wallet's default
		await postJ("/api/categories", { delete: "Food", move_to: "Drinks" });
		expect(cat("off")).toBe("Drinks");
	});

	it("with a category to move to: every line, rule and wallet default moves there and the name is gone, in one step", async () => {
		await put(raw, "accounts", { ...PREPAID, wallet_spend_category: "food" });
		const before = await october();
		const r = await postJ("/api/categories", { delete: "Food", move_to: "drinks" });
		expect(r).toMatchObject({ ok: true, categories: ["Drinks", "Snacks", "Others"], moved_to: "Drinks", moved_lines: 3 });
		expect([cat("f1"), cat("f2"), cat("f3"), cat("d1")]).toEqual(["Drinks", "Drinks", "Drinks", "Drinks"]);
		expect(nothingNamed("Food")).toEqual({ lines: 0, payees: 0, wallets: 0 });
		const head = await readHead(raw);
		expect(head!.body.category_rules).toEqual([{ merchant_key: "RICE SHOP", category: "Drinks" }, { merchant_key: "NOODLE BAR", category: "Drinks", by: "owner" }, { merchant_key: "TEA HOUSE", category: "Drinks" }]);
		expect(head!.body.categories).toEqual(["Drinks", "Snacks", "Others"]);
		expect(raw.raw.prepare("SELECT line_id, after_json FROM line_events WHERE event = 'category_delete' ORDER BY line_id").all()).toEqual(["f1", "f2", "f3"].map((id) => ({ line_id: id, after_json: '{"category":"Drinks"}' })));
		const after = await october();
		expect(after.by.Food).toBeUndefined();
		expect(after.by.Drinks).toBe(1870); // by hand: 15.50 + 3.20
		expect(after.total).toBe(before.total);
	});

	it("cannot move into itself or into a name that is not his", async () => {
		expect((await postJ("/api/categories", { delete: "Food", move_to: "food" })).message).toBe("'Food' cannot be moved into itself; choose another category");
		expect((await postJ("/api/categories", { delete: "Food", move_to: "Travel" })).message).toMatch(/^'Travel' is not one of your categories/);
		expect(cat("f1")).toBe("Food");
	});

	it("when a rule changed underneath (someone published between), nothing half-moves: it reads again and finishes", async () => {
		// The guard: every write waits on the head this call published. Simulate the race by publishing
		// between this call's read and its batch — the batch must be a no-op, then the retry completes.
		const db = raw;
		const realBatch = db.batch.bind(db);
		let raced = false;
		(db as { batch: typeof db.batch }).batch = async (stmts) => {
			if (!raced && stmts.length > 6) {
				raced = true;
				const h = await readHead(db);
				await publishPlaybook(db, { ...h!.body, category_rules: [...h!.body.category_rules, { merchant_key: "LATE SHOP", category: "Food" }] }, h!.version, "senior", "race", AT);
			}
			return realBatch(stmts);
		};
		try {
			const r = await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
			expect(r.ok).toBe(true);
		} finally {
			(db as { batch: typeof db.batch }).batch = realBatch;
		}
		expect(raced).toBe(true);
		const rules = (await readHead(raw))!.body.category_rules;
		expect(rules.find((x) => x.merchant_key === "LATE SHOP")).toEqual({ merchant_key: "LATE SHOP", category: "Eating Out" });
		expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM line_events WHERE event = 'category_rename'").get()).toEqual({ n: 3 });
		expect(nothingNamed("Food")).toEqual({ lines: 0, payees: 0, wallets: 0 });
	});
});

describe("the reader after a rename or delete (the every-minute tick)", () => {
	const tick = (claude: FakeClaude) => runTick(makeEnv(withLikeCap(raw), { ...MODELS, LEDGER_CATEGORIES: "Food, Drinks, Snacks, Others" }), app.deps, { claude }, [sortMerchants, categorise]);

	it("a new line from a shop the reader had learned arrives in the NEW name", async () => {
		await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
		await put(raw, "lines", line({ id: "new-rice", account_id: "card-a", txn_date: "2026-10-08", merchant_key: "RICE SHOP", merchant_name: "Rice Shop", category: null }));
		await tick(new FakeClaude(() => ({ rules: [] })));
		expect(cat("new-rice")).toBe("Eating Out");
	});

	it("the reader is offered the owner's list as it is now: renamed, and without a deleted starting category", async () => {
		await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
		await postJ("/api/categories", { delete: "Snacks" });
		await put(raw, "lines", line({ id: "u1", account_id: "card-a", txn_date: "2026-10-08", merchant_key: "UNSORTED PLACE", merchant_name: "Unsorted Place", category: null }));
		const claude = new FakeClaude(() => ({ rules: [{ merchant_key: "UNSORTED PLACE", category: "Food" }] }));
		await tick(claude);
		expect(claude.calls[0]!.user).toContain("Eating Out, Drinks, Others");
		expect(claude.calls[0]!.user).not.toContain("Snacks");
		// A model answering with the old name is not taken: the line stays unsorted, never "Food".
		expect(cat("u1")).toBeNull();
	});
});

describe("a tick that was already running when the owner renamed or deleted", () => {
	const tick = () => runTick(makeEnv(withLikeCap(raw), { ...MODELS, LEDGER_CATEGORIES: "Food, Drinks, Snacks, Others" }), app.deps, {}, [categorise]);

	it("an old name it wrote afterwards (on a line, or a learned shop) is moved to the new one by the next tick", async () => {
		await postJ("/api/categories", { rename: "Food", to: "Eating Out" });
		await postJ("/api/categories", { rename: "Eating Out", to: "Meals" });
		// What a tick that read the list and rules before the rename could still write:
		await put(raw, "lines", line({ id: "late", account_id: "card-a", txn_date: "2026-10-08", merchant_key: "LATE SHOP", category: "Food" }));
		const h = await readHead(raw);
		await publishPlaybook(raw, { ...h!.body, categories: [...h!.body.categories, "Food"], category_rules: [...h!.body.category_rules, { merchant_key: "LATE SHOP", category: "Food" }] }, h!.version, "senior", "a late sort", AT);
		await tick();
		expect(cat("late")).toBe("Meals");
		const book = (await readHead(raw))!.body;
		expect(book.category_rules.find((r) => r.merchant_key === "LATE SHOP")).toEqual({ merchant_key: "LATE SHOP", category: "Meals" });
		expect(book.categories).not.toContain("Food");
		expect(nothingNamed("Food")).toEqual({ lines: 0, payees: 0, wallets: 0 });
		expect((await getJ("/api/categories")).categories).toEqual(["Meals", "Drinks", "Snacks", "Others"]);
	});

	it("an old name of a category deleted with nothing in it goes back to no category (the rules sort it again)", async () => {
		await postJ("/api/categories", { delete: "Snacks" });
		await put(raw, "lines", line({ id: "late2", account_id: "card-a", txn_date: "2026-10-08", merchant_key: "COOKIE CO", category: "Snacks" }));
		await tick();
		expect(cat("late2")).toBeNull();
	});
});
