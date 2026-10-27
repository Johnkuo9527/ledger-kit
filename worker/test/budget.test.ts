/// Cloudflare's free plan lets one request make at most 50 D1 queries; past
/// that, the request fails. The owner's ledger grows every day, so every page read
/// and every connector tool is measured here against a ledger with years of
/// trips — and must stay inside the limit with room to spare.

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { line, statement } from "../../test/helpers/fixtures";
import { put, tripRow } from "../../test/helpers/world";
import { API_ROUTES } from "../src/api";
import { handleRequest } from "../src/app";
import { handleMcp } from "../src/mcp";
import { BASE, countingDb, CTX, get, makeDeps, makeEnv, OWNER, post, seedWorld, signedIn, TEST_ASSETS } from "./helpers/harness";

/// The free plan's limit, with a margin for what the daily engine may add to a request.
const BUDGET = 40;

let raw: TestDb;
let counter: ReturnType<typeof countingDb>;
let cookie: string;

beforeAll(async () => {
	raw = freshDb();
	await seedWorld(raw);
	// Two years of travel: 40 trips with a few overseas lines each, 600 lines in all, 24 statements.
	for (let i = 0; i < 40; i++) {
		const m = String((i % 12) + 1).padStart(2, "0");
		const y = i < 20 ? 2025 : 2026;
		const d = `${y}-${m}-${String((i % 25) + 1).padStart(2, "0")}`;
		await put(raw, "trips", tripRow({ id: `bt-${i}`, status: i % 4 ? "confirmed" : "proposed", start_date: d, end_date: d }));
		for (let k = 0; k < 4; k++) await put(raw, "lines", line({ id: `bl-${i}-${k}`, txn_date: d, merchant_country: "JP", orig_currency: "JPY", orig_minor: 1000 + k, bill_minor: 900, home_minor: 900, merchant_name: `Shop ${k}` }));
	}
	for (let i = 0; i < 440; i++) await put(raw, "lines", line({ id: `hl-${i}`, txn_date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`, merchant_name: `Local ${i % 30}` }));
	for (let i = 0; i < 24; i++) await put(raw, "statements", statement({ id: `bs-${i}`, account_id: "card-a", period_end: `20${24 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-15` }));
	counter = countingDb(raw);
	cookie = await signedIn();
});
afterAll(() => raw.close());

const env = () => makeEnv(counter.db, { LEDGER_CATEGORIES: "Food, Shopping, Others" });
const app = { assets: TEST_ASSETS, deps: makeDeps() };

async function measure(call: () => Promise<Response>): Promise<number> {
	counter.reset();
	const res = await call();
	expect(res.status).toBeLessThan(300);
	if (process.env.SHOW_BUDGET) console.log(`${counter.queries()} queries`);
	return counter.queries();
}

describe("every page read stays inside the free plan's D1 limit", () => {
	const reads = API_ROUTES.filter((r) => r.method === "GET").map((r) => r.pattern.source.replace(/^\^/, "").replace(/\$$/, "").replaceAll("\\/", "/"));
	it.each([...reads, "/api/lines?trip=bt-3", "/api/lines?q=shop&from=2025-01-01", "/api/overview?month=2025-06"])("%s", async (path) => {
		expect(await measure(() => handleRequest(get(path, cookie), env(), CTX, app))).toBeLessThanOrEqual(BUDGET);
	});
});

describe("every page write too", () => {
	it.each([
		["/api/trips/bt-0/confirm", { end_date: "2025-01-02" }],
		["/api/lines/hl-1/reimbursable", { value: true }],
		["/api/reimbursable-ranges", { from: "2025-01-01", to: "2025-12-31" }],
		["/api/cash", { amount: "3.20", merchant: "Kopi" }],
		["/api/wallet-names", { name: "Mystery Card", account_id: "card-b" }],
		["/api/lines/hl-9/category", { category: "Food" }],
		["/api/categories", { add: "Travel" }],
		["/api/trips", { name: "Japan", start_date: "2025-03-01", end_date: "2025-03-08" }],
		["/api/lines/hl-10/category", { category: "Shopping", scope: "line" }],
		["/api/accounts/card-a/settings", { autopay: true }],
	] as const)("%s", async (path, body) => {
		expect(await measure(() => handleRequest(post(path, body, cookie), env(), CTX, app))).toBeLessThanOrEqual(BUDGET);
	});

	// Renaming or deleting a category moves every line in it in a few set-based statements, however many
	// (23 Oct 2026): here 440 lines and 30 payee rules, then all of them moved again by a delete.
	it("renaming a category with hundreds of lines, then deleting it with a move, and the usage counts", async () => {
		raw.raw.prepare("UPDATE lines SET category = 'Shopping' WHERE id LIKE 'hl-%'").run();
		for (let i = 0; i < 30; i++) raw.raw.prepare("INSERT OR REPLACE INTO payee_rules (merchant_key, kind, category, set_by, updated_at) VALUES (?, NULL, 'Shopping', 'owner', '2026-10-09')").run(`LOCAL ${i}`);
		expect(await measure(() => handleRequest(get("/api/categories?usage=1", cookie), env(), CTX, app))).toBeLessThanOrEqual(BUDGET);
		expect(await measure(() => handleRequest(post("/api/categories", { rename: "Shopping", to: "Things" }, cookie), env(), CTX, app))).toBeLessThanOrEqual(BUDGET);
		expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM lines WHERE category = 'Things'").get()).toEqual({ n: 440 });
		expect(await measure(() => handleRequest(post("/api/categories", { delete: "Things", move_to: "Others" }, cookie), env(), CTX, app))).toBeLessThanOrEqual(BUDGET);
		expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM lines WHERE category = 'Others'").get()).toEqual({ n: 440 });
		// Back as it was, for the connector's measurements below (they name Shopping).
		raw.raw.prepare("UPDATE lines SET category = NULL WHERE id LIKE 'hl-%'").run();
		raw.raw.prepare("DELETE FROM payee_rules WHERE merchant_key LIKE 'LOCAL %'").run();
		raw.raw.prepare("DELETE FROM sync_state WHERE key = 'category_list'").run();
	});

	it("an Apple Pay tap", async () => {
		const tap = { card: "Test Rewards", merchant: "Budget Bakery", amount: "S$2.40", timestamp: "2026-10-09T07:00:00+08:00" };
		expect(await measure(() => handleRequest(post("/api/shortcut/tap", tap, undefined, { Authorization: `Bearer ${makeEnv(raw).LEDGER_SHORTCUT_KEY}` }), env(), CTX, app))).toBeLessThanOrEqual(BUDGET);
	});
});

describe("every connector tool", () => {
	const call = (name: string, args: object) =>
		handleMcp(
			new Request(`${BASE}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
			}),
			env(),
			{ waitUntil() {}, props: { email: OWNER } },
			app.deps,
		);
	it.each([
		["ledger_query", { from: "2024-01-01", to: "2026-10-09", group_by: "merchant", limit: 200 }],
		["ledger_query", { trip_id: "bt-5", from: "2024-01-01" }],
		["ledger_add_cash", { amount: "5", merchant: "x" }],
		["ledger_add_cash", { account: "card-c", amount: "6.80", merchant: "Bakery", category: "Food" }],
		["ledger_mark_reimbursable", { trip_id: "bt-8" }],
		["ledger_mark_reimbursable", { range: { from: "2025-01-01", to: "2025-12-31" } }],
		["ledger_confirm_trip", { action: "list" }],
		["ledger_confirm_trip", { action: "confirm", trip_id: "bt-12", name: "Twelve" }],
		["ledger_subscriptions", { status: "all" }],
		["ledger_set_category", { merchant: "Local 1", category: "Food" }],
		["ledger_set_category", { line_id: "hl-7", category: "Shopping" }],
		["ledger_bills", {}],
		["ledger_bills", { card: "card-a", paid: true, autopay: false }],
	] as const)("%s %j", async (name, args) => {
		const n = await measure(() => call(name, args));
		expect(n).toBeLessThanOrEqual(BUDGET);
	});
});
