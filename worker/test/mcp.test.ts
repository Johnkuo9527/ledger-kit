/// The claude.ai connector's tools (CONTRACT.md §6, plus ledger_set_category and ledger_income_offset), spoken to over MCP
/// exactly as claude.ai does — JSON-RPC over Streamable HTTP — after the OAuth
/// library has let the request in (oauth.test.ts proves that door).
/// Made-up data only.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { line, statement } from "../../test/helpers/fixtures";
import { put } from "../../test/helpers/world";
import type { Ctx, LedgerEnv } from "../src/env";
import { handleMcp } from "../src/mcp";
import { BASE, makeDeps, makeEnv, OWNER, seedWorld, withLikeCap, type World } from "./helpers/harness";

let raw: TestDb;
let env: LedgerEnv;
let world: World;
const deps = makeDeps();
const ownerCtx: Ctx = { waitUntil() {}, props: { email: OWNER } };

beforeEach(async () => {
	raw = freshDb();
	world = await seedWorld(raw);
	env = makeEnv(withLikeCap(raw));
});
afterEach(() => raw.close());

let nextId = 1;
function rpcRequest(method: string, params: unknown = {}): Request {
	return new Request(`${BASE}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
}

async function rpc(method: string, params: unknown = {}, ctx: Ctx = ownerCtx): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
	const res = await handleMcp(rpcRequest(method, params), env, ctx, deps);
	expect(res.status).toBe(200);
	return (await res.json()) as { result?: Record<string, unknown> };
}

/// Call a tool; return its envelope and whether MCP marked it an error.
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ body: Record<string, unknown> & { ok: boolean; message?: string }; isError: boolean }> {
	const r = await rpc("tools/call", { name, arguments: args });
	const result = r.result as { content: { type: string; text: string }[]; isError?: boolean };
	expect(result.content[0]!.type).toBe("text");
	return { body: JSON.parse(result.content[0]!.text), isError: result.isError === true };
}

describe("speaking MCP", () => {
	it("initialize: names itself, offers tools, and tells Claude how to read the ledger", async () => {
		const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
		expect(r.result).toMatchObject({ serverInfo: { name: "ledger" }, capabilities: { tools: {} } });
		expect(String(r.result!.instructions)).toContain("coverage");
		expect(String(r.result!.instructions)).toContain("Never present a missing period as zero spending");
	});

	it("lists exactly the ten tools (§6's five + ledger_set_category + ledger_income_offset + ledger_set_kind + ledger_bills + ledger_categories), with input schemas", async () => {
		const tools = (await rpc("tools/list")).result!.tools as { name: string; inputSchema: { type: string }; annotations?: { readOnlyHint?: boolean } }[];
		expect(tools.map((t) => t.name).sort()).toEqual(["ledger_add_cash", "ledger_bills", "ledger_categories", "ledger_confirm_trip", "ledger_income_offset", "ledger_mark_reimbursable", "ledger_query", "ledger_set_category", "ledger_set_kind", "ledger_subscriptions"]);
		for (const t of tools) expect(t.inputSchema.type).toBe("object");
		expect(tools.find((t) => t.name === "ledger_query")!.annotations?.readOnlyHint).toBe(true);
	});

	it("answers 403 to a token that is not the owner's — or when no owner is set", async () => {
		for (const [ctx, e] of [
			[{ waitUntil() {}, props: { email: "someone@else.example" } }, env],
			[{ waitUntil() {} }, env],
			[ownerCtx, makeEnv(raw, { LEDGER_OWNER_EMAIL: undefined })],
		] as const) {
			const res = await handleMcp(rpcRequest("tools/list"), e, ctx, deps);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ ok: false, message: "this ledger belongs to someone else" });
		}
	});

	it("the owner's address is matched without regard to case or spaces", async () => {
		const res = await handleMcp(rpcRequest("tools/list"), makeEnv(raw, { LEDGER_OWNER_EMAIL: `  ${OWNER.toUpperCase()} ` }), ownerCtx, deps);
		expect(res.status).toBe(200);
	});
});

describe("ledger_query", () => {
	it("defaults to this month so far; the total covers everything, split confirmed / estimate; top lines largest first", async () => {
		// 4.50 + 30.00 + 12.00 + 42.00 = 88.50; the 台新 42.00 is a reference-rate estimate → confirmed 46.50.
		const { body, isError } = await tool("ledger_query");
		expect(isError).toBe(false);
		expect(body).toMatchObject({
			ok: true,
			period: { from: "2026-10-01", to: "2026-10-09" },
			totals: { spending_home: { display: "SGD 88.50" }, count: 4 },
			split: { confirmed_home: { minor: 4650 }, estimate_home: { minor: 4200 } },
			matched: 4,
			truncated: false,
		});
		expect((body.lines as { id: string }[]).map((l) => l.id)).toEqual([world.twd, world.book, world.cash, world.kopi]);
		const taishin = (body.coverage as { account_id: string; partial: boolean; message: string }[]).find((c) => c.account_id === "card-t")!;
		expect(taishin.partial).toBe(true);
	});

	it("plain-language filters: an account by part of its name, a trip by its destination, merchant text, grouping", async () => {
		const t = await tool("ledger_query", { account_id: "card-t" });
		expect((t.body.lines as { id: string }[]).map((l) => l.id)).toEqual([world.twd]);
		expect(t.body.coverage).toHaveLength(1);
		const trip = await tool("ledger_query", { trip_id: "testville", from: "2026-01-01" });
		expect((trip.body.lines as { id: string }[]).map((l) => l.id)).toEqual([world.booking]);
		const grouped = await tool("ledger_query", { from: "2026-09-01", group_by: "merchant", limit: 1 });
		expect(grouped.body).toMatchObject({ matched: 5, truncated: true });
		expect((grouped.body.groups as { key: string }[])[0]!.key).toBe("Night Market");
		const kopi = await tool("ledger_query", { merchant: "KOPI" });
		expect(kopi.body).toMatchObject({ matched: 1, totals: { spending_home: { minor: 450 } } });
	});

	it("refuses an ambiguous account with the candidates, never a guess", async () => {
		const { body, isError } = await tool("ledger_query", { account_id: "hsbc" });
		expect(isError).toBe(true);
		expect(body.ok).toBe(false);
		expect(body.message).toContain("matches more than one account");
		expect(body.message).toContain("card-a");
		expect(body.message).toContain("card-b");
	});

	it("refuses a backwards period and an input the schema does not allow — as errors, not crashes", async () => {
		expect((await tool("ledger_query", { from: "2026-10-05", to: "2026-10-01" })).body.message).toContain("before it starts");
		const r = await rpc("tools/call", { name: "ledger_query", arguments: { limit: 9999 } });
		expect(r.error ?? (r.result as { isError?: boolean }).isError).toBeTruthy();
	});
});

describe("ledger_add_cash", () => {
	it("adds cash today in SGD by default, as the owner's own word", async () => {
		const { body } = await tool("ledger_add_cash", { amount: "12.50", merchant: "Taxi" });
		expect(body).toMatchObject({ ok: true, line: { date: "2026-10-09", account: { id: "cash" }, amount: { home: { minor: 1250, status: "exact" } }, provisional: false } });
		const id = (body.line as { id: string }).id;
		expect(await raw.prepare("SELECT actor, event FROM line_events WHERE line_id = ?").bind(id).first()).toEqual({ actor: "owner", event: "create" });
	});

	it("foreign cash with what it cost in SGD; and correcting a 台新 line's SGD", async () => {
		const yen = await tool("ledger_add_cash", { date: "2026-10-08", amount: 1200, currency: "jpy", merchant: "Ramen", home_amount: "10.80" });
		expect(yen.body.line).toMatchObject({ amount: { original: { currency: "JPY", minor: 1200 }, home: { minor: 1080, status: "confirmed", set_by: "owner" } } });
		const fix = await tool("ledger_add_cash", { line_id: world.twd, home_amount: "41.10" });
		expect(fix.body.line).toMatchObject({ id: world.twd, amount: { home: { minor: 4110, status: "confirmed" } } });
	});

	it("refuses a card's line (its statement confirms it), a missing merchant, a future date", async () => {
		expect((await tool("ledger_add_cash", { line_id: world.kopi, home_amount: "4" })).body.message).toContain("statement confirms it");
		expect((await tool("ledger_add_cash", { amount: "5" })).body.message).toBe("merchant is missing");
		expect((await tool("ledger_add_cash", { amount: "5", merchant: "x", date: "2026-12-25" })).isError).toBe(true);
	});

	it("a card purchase no alert or tap brought: a provisional line on that card, his word, not a second line when the tap already did", async () => {
		const { body } = await tool("ledger_add_cash", { account: "card-c", date: "2026-10-08", amount: "6.80", merchant: "Bakery", category: "Food" });
		expect(body).toMatchObject({
			ok: true,
			already_recorded: false,
			line: { account: { id: "card-c" }, date: "2026-10-08", category: "Food", provisional: true, evidence: ["manual"], amount: { original: { currency: "SGD", minor: 680 }, home: { minor: 680 } } },
		});
		// The Kopi Corner tap on card A already recorded S$4.50 on the 2nd: his word joins it.
		const again = await tool("ledger_add_cash", { account: "card-a", date: "2026-10-02", amount: "4.50", merchant: "Kopi Corner" });
		expect(again.body).toMatchObject({ ok: true, already_recorded: true, line: { id: world.kopi } });
		expect((again.body.line as { evidence: string[] }).evidence.sort()).toEqual(["apple_pay_shortcut", "manual"]);
	});

	it("refuses an SGD figure for a card purchase and any bank account", async () => {
		expect((await tool("ledger_add_cash", { account: "card-c", amount: 1200, currency: "JPY", merchant: "Ramen", home_amount: "11" })).body.message).toContain("statement confirms what it cost");
		expect((await tool("ledger_add_cash", { account: "bank-x", amount: "5", merchant: "x" })).body.message).toContain("bank account");
	});
});

describe("ledger_mark_reimbursable", () => {
	it("a date range: every spending line in it, counted", async () => {
		// 10-02 … 10-04: Kopi 4.50 + Bookshop 30.00 + Hawker cash 12.00 = 46.50, 3 lines.
		const { body } = await tool("ledger_mark_reimbursable", { range: { from: "2026-10-02", to: "2026-10-04", note: "client week" } });
		expect(body).toMatchObject({ ok: true, affected_lines: 3, reimbursable_total_home: { minor: 4650 } });
		expect((body.ranges as { note: string }[])[0]!.note).toBe("client week");
	});

	it("one line out of the range, then back; then the range removed", async () => {
		const r = await tool("ledger_mark_reimbursable", { range: { from: "2026-10-02", to: "2026-10-04" } });
		const rangeId = (r.body.ranges as { id: string }[])[0]!.id;
		expect((await tool("ledger_mark_reimbursable", { line_id: world.book, reimbursable: false })).body).toMatchObject({ affected_lines: 1, reimbursable_total_home: { minor: 0 } });
		expect((await tool("ledger_mark_reimbursable", { line_id: world.book, reimbursable: null })).body).toMatchObject({ affected_lines: 1, reimbursable_total_home: { minor: 3000 } });
		// Removing the range: the three lines stop being reimbursable.
		expect((await tool("ledger_mark_reimbursable", { remove_range_id: rangeId })).body).toMatchObject({ ranges: [], affected_lines: 3, reimbursable_total_home: { minor: 0 } });
	});

	it("a trip: its dates become a range and its booking (paid in August) is marked too", async () => {
		const { body } = await tool("ledger_mark_reimbursable", { trip_id: "Testville" });
		expect(body).toMatchObject({ ok: true, affected_lines: 1, reimbursable_total_home: { minor: 50000 } });
		expect(body.ranges).toEqual([expect.objectContaining({ start_date: "2026-09-10", end_date: "2026-09-14", note: "Testville, JP" })]);
	});

	it("exactly one way at a time", async () => {
		const { body, isError } = await tool("ledger_mark_reimbursable", { line_id: world.kopi, reimbursable: true, trip_id: "Testville" });
		expect(isError).toBe(true);
		expect(body.message).toContain("exactly one of");
		expect((await tool("ledger_mark_reimbursable", { line_id: world.kopi })).body.message).toContain("reimbursable: true, false, or null");
	});
});

describe("ledger_confirm_trip", () => {
	it("lists proposed and confirmed trips", async () => {
		const { body } = await tool("ledger_confirm_trip", { action: "list" });
		expect((body.trips as { id: string; status: string }[]).map((t) => [t.id, t.status])).toEqual([
			["trip-p", "proposed"],
			["trip-c", "confirmed"],
		]);
	});

	it("confirms by destination, with the owner's corrected end date, and returns the trip with its lines", async () => {
		const { body } = await tool("ledger_confirm_trip", { action: "confirm", trip_id: "testville", end_date: "2026-09-16", name: "Testville work trip" });
		expect(body).toMatchObject({ ok: true, trip: { id: "trip-p", status: "confirmed", end_date: "2026-09-16", name: "Testville work trip", total_home: { minor: 50000 } } });
		expect((body.lines as { id: string }[]).map((l) => l.id)).toEqual([world.booking]);
	});

	it("excludes a line the owner says was not part of it", async () => {
		const { body } = await tool("ledger_confirm_trip", { action: "edit", trip_id: "trip-p", exclude_line_ids: [world.booking] });
		expect(body).toMatchObject({ trip: { line_count: 0, total_home: { minor: 0 } }, lines: [] });
	});

	it("refuses what the contract does not allow, in words", async () => {
		expect((await tool("ledger_confirm_trip", { action: "dismiss", trip_id: "trip-c" })).body.message).toBe("a confirmed trip cannot be dismissed");
		expect((await tool("ledger_confirm_trip", { action: "edit", trip_id: "trip-c" })).body.message).toContain("nothing to change");
		expect((await tool("ledger_confirm_trip", { action: "confirm", trip_id: "Atlantis" })).body.message).toContain('no trip matches "Atlantis"');
		expect((await tool("ledger_confirm_trip", { action: "dismiss", trip_id: "trip-p", name: "x" })).body.message).toContain('not "dismiss"');
	});
});

describe("ledger_subscriptions", () => {
	it("lists the active ones with the monthly total; the owner says one is cancelled, by its merchant's name", async () => {
		const list = await tool("ledger_subscriptions");
		expect(list.body).toMatchObject({ ok: true, monthly_total_home: { minor: 1599 }, subscriptions: [{ id: "sub-s", status: "active" }] });
		const cancelled = await tool("ledger_subscriptions", { subscription_id: "streamco", action: "cancelled" });
		expect(cancelled.body).toMatchObject({ subscriptions: [], monthly_total_home: { minor: 0 } });
		expect((await tool("ledger_subscriptions", { status: "all" })).body.subscriptions).toEqual([expect.objectContaining({ id: "sub-s", status: "cancelled" })]);
		expect((await tool("ledger_subscriptions", { subscription_id: "sub-s" })).body.message).toContain("say what to do");
	});
});

describe("a crash is an error result with no internals, and nothing half-done", () => {
	it("the database failing", async () => {
		env = makeEnv({
			prepare() {
				throw new Error("D1_ERROR: internal detail");
			},
			batch: async () => [],
		});
		const { body, isError } = await tool("ledger_query");
		expect(isError).toBe(true);
		expect(body).toEqual({ ok: false, message: "the ledger could not answer just now; nothing was changed by this call" });
	});
});

describe("ledger_bills (14 Oct 2026)", () => {
	it("lists 繳款; the owner's 「我已繳款」 and auto-debit word by card name; refuses an unknown card", async () => {
		await put(raw, "statements", statement({ id: "bill-c", account_id: "card-c", period_start: "2026-08-21", period_end: "2026-09-20", statement_balance_minor: 30_000, due_date: "2026-10-03", recon_status: "reconciled" }));
		const list = await tool("ledger_bills");
		expect((list.body.bills as { cards: { account: { id: string }; status: string }[] }).cards.find((c) => c.account.id === "card-c")).toMatchObject({ status: "overdue", status_reason: "no_payment_seen" });
		const paid = await tool("ledger_bills", { card: "card-c", paid: true });
		expect(paid.isError).toBe(false);
		expect(paid.body.message).toContain("the owner's word");
		expect((paid.body.bills as { cards: Record<string, unknown>[] }).cards.find((c) => (c.account as { id: string }).id === "card-c")).toMatchObject({ status: "paid", paid_source: "owner" });
		const auto = await tool("ledger_bills", { card: "card-t", autopay: true });
		expect(auto.isError).toBe(false);
		expect(raw.raw.prepare("SELECT autopay FROM accounts WHERE id = 'card-t'").get()).toEqual({ autopay: 1 });
		expect((await tool("ledger_bills", { card: "nothing-like-it", paid: true })).body.message).toContain("no credit card matches");
		expect((await tool("ledger_bills", { paid: true })).body.message).toContain("say which card");
	});
});

describe("ledger_categories: the owner renames or deletes a category by telling Claude (23 Oct 2026)", () => {
	beforeEach(async () => {
		env = makeEnv(withLikeCap(raw), { LEDGER_CATEGORIES: "Food, Drinks, Others" });
		await put(raw, "lines", line({ id: "m1", account_id: "card-a", txn_date: "2026-10-07", category: "Food", merchant_key: "NOODLE BAR" }));
	});

	it("list: each category with how many lines and rules use it", async () => {
		const { body } = await tool("ledger_categories", {});
		expect(body).toMatchObject({ ok: true, categories: ["Food", "Drinks", "Others"], usage: { Food: { lines: 1, rules: 0 }, Drinks: { lines: 0, rules: 0 } } });
	});

	it("rename: the lines follow; onto a name he has: refused, saying how to merge", async () => {
		expect((await tool("ledger_categories", { action: "rename", category: "food", new_name: "Meals" })).body).toMatchObject({ ok: true, categories: ["Meals", "Drinks", "Others"], moved_lines: 1 });
		const clash = await tool("ledger_categories", { action: "rename", category: "Meals", new_name: "drinks" });
		expect(clash.isError).toBe(true);
		expect(clash.body.message).toBe("'Drinks' is already one of your categories. To put everything in 'Meals' into 'Drinks', delete 'Meals' and move it to 'Drinks'");
	});

	it("delete: refused with the count until he names where they go; then moved and gone", async () => {
		const ask = await tool("ledger_categories", { action: "delete", category: "Food" });
		expect(ask.isError).toBe(true);
		expect(ask.body.message).toBe("'Food' is used by 1 line; say which category they move to (move_to: one of Drinks, Others)");
		expect((await tool("ledger_categories", { action: "delete", category: "Food", move_to: "Others" })).body).toMatchObject({ ok: true, categories: ["Drinks", "Others"], moved_to: "Others", moved_lines: 1 });
		expect((await tool("ledger_categories", { action: "delete", category: "Drinks" })).body).toMatchObject({ ok: true, categories: ["Others"] });
	});

	it("an action without what it needs is refused plainly", async () => {
		expect((await tool("ledger_categories", { action: "rename", category: "Food" })).body.message).toBe("new_name is missing");
		expect((await tool("ledger_categories", { action: "delete" })).body.message).toBe("category is missing");
	});
});
