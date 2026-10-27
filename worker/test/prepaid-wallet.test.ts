/// Any prepaid wallet, by the owner's word through the connector and the page
/// (19 Oct 2026): his Sample Bistro stored-value card beside GrabPay.
/// ledger_set_kind {kind: wallet_topup, wallet} (grabpay_topup still works),
/// POST /api/lines/:id/kind {kind: wallet_topup, wallet}, and ledger_add_cash
/// with account "sample-bistro" (category Food unless he names one).
/// The wallets are the made-up ones in test/helpers/fixtures.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../../src/db";
import { line, PREPAID, WALLET } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts, put } from "../../test/helpers/world";
import { handleRequest, type App } from "../src/app";
import type { Ctx, LedgerEnv } from "../src/env";
import { handleMcp } from "../src/mcp";
import { BASE, CTX, get, json, makeDeps, makeEnv, OWNER, post, signedIn, TEST_ASSETS, withLikeCap } from "./helpers/harness";

let raw: TestDb;
let env: LedgerEnv;
let app: App & { deps: ReturnType<typeof makeDeps> };
beforeEach(async () => {
	raw = freshDb();
	await addAccounts(raw);
	await insertRow(raw, "accounts", WALLET).run();
	await insertRow(raw, "accounts", PREPAID).run();
	env = makeEnv(withLikeCap(raw), { LEDGER_CATEGORIES: "Food, Drinks, Grab/Uber, Others" });
	app = { assets: TEST_ASSETS, deps: makeDeps("2026-10-20T08:00:00.000Z") };
});
afterEach(() => raw.close());

const ctx: Ctx = { waitUntil() {}, props: { email: OWNER } };
async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
	const res = await handleMcp(
		new Request(`${BASE}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		}),
		env,
		ctx,
		app.deps,
	);
	const r = (await res.json()) as { result: { content: { text: string }[] } };
	return JSON.parse(r.result.content[0]!.text) as Record<string, any>;
}
const lines = () => raw.raw.prepare("SELECT * FROM lines WHERE state <> 'void' ORDER BY created_at, id").all() as Record<string, any>[];
const spend = () => lines().filter((l) => ["purchase", "fee", "refund", "wallet_offset"].includes(l.kind)).reduce((s, l) => s + l.home_minor, 0);
const balance = (id: string, opening: number) => opening - lines().filter((l) => l.account_id === id && l.kind !== "wallet_offset").reduce((s, l) => s + l.bill_minor, 0);
/// The owner's live line, made up: S$200.00 on a card at SAMPLE BISTRO on 19 Oct, read as spending.
const citi = (id = "hg-200", minor = 20000) =>
	put(raw, "lines", line({ id, account_id: "card-c", kind: "purchase", txn_date: "2026-10-19", merchant_raw: "SAMPLE BISTRO         SINGAPORE", merchant_key: "SAMPLE BISTRO", merchant_name: "Sample Bistro", orig_minor: minor, bill_minor: minor, home_minor: minor }));

describe("ledger_set_kind: a top-up of whichever wallet the owner names", () => {
	it("wallet_topup with wallet sample-bistro turns the S$200 card line into a transfer to it: not spending, balance S$200", async () => {
		await citi();
		expect(spend()).toBe(20000);
		const r = await tool("ledger_set_kind", { kind: "wallet_topup", wallet: "sample-bistro", line_id: "hg-200" });
		expect(r.message).toBeUndefined();
		expect(r.ok).toBe(true);
		expect(r.line).toMatchObject({ kind: "transfer", spending: false });
		expect(spend()).toBe(0);
		expect(balance(PREPAID.id, 0)).toBe(20000);
		expect(balance(WALLET.id, 4200)).toBe(4200);
	});

	it("the wallet may be named by its id or its name; never guessed when he has two wallets; a card is not a wallet", async () => {
		await citi();
		const none = await tool("ledger_set_kind", { kind: "wallet_topup", line_id: "hg-200" });
		expect(none.ok).toBe(false);
		expect(none.message).toMatch(/say which wallet/);
		expect(none.message).toContain(PREPAID.id);
		expect(none.message).toContain(WALLET.id);
		const card = await tool("ledger_set_kind", { kind: "wallet_topup", wallet: "card-a", line_id: "hg-200" });
		expect(card.ok).toBe(false);
		expect(card.message).toMatch(/not a wallet/);
		expect(spend()).toBe(20000); // nothing moved
		const named = await tool("ledger_set_kind", { kind: "wallet_topup", wallet: "Sample Bistro", line_id: "hg-200" });
		expect(named.ok).toBe(true);
		expect(balance(PREPAID.id, 0)).toBe(20000);
	});

	it("grabpay_topup still means a GrabPay top-up — and refuses another wallet rather than guess", async () => {
		put(raw, "lines", line({ id: "grab-15", account_id: "bank-x", kind: "purchase", txn_date: "2026-10-15", merchant_raw: "GRAB", merchant_key: "GRAB", orig_minor: 1234, bill_minor: 1234, home_minor: 1234 }));
		const r = await tool("ledger_set_kind", { kind: "grabpay_topup", line_id: "grab-15" });
		expect(r.ok).toBe(true);
		expect(balance(WALLET.id, 4200)).toBe(4200 + 1234);
		expect(balance(PREPAID.id, 0)).toBe(0);
		await citi();
		const wrong = await tool("ledger_set_kind", { kind: "grabpay_topup", wallet: "sample-bistro", line_id: "hg-200" });
		expect(wrong.ok).toBe(false);
		expect(wrong.message).toMatch(/wallet_topup/);
	});

	it("a top-up is one line at a time: a payee rule could move a meal paid by card", async () => {
		await citi();
		const r = await tool("ledger_set_kind", { kind: "wallet_topup", wallet: "sample-bistro", merchant: "sample bistro" });
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/one line at a time/);
	});

	it("the list of kinds names wallet_topup", async () => {
		const r = await tool("ledger_set_kind", {});
		expect(r.kinds).toEqual(expect.arrayContaining(["wallet_topup", "grabpay_topup"]));
	});
});

describe("the page's 「儲值到…」: POST /api/lines/:id/kind {kind: wallet_topup, wallet}", () => {
	it("turns the line into a top-up of the wallet he tapped; a merchant-wide top-up is refused", async () => {
		await citi();
		const cookie = await signedIn();
		const send = (r: Request) => handleRequest(r, env, CTX, app);
		const all = await send(post("/api/lines/hg-200/kind", { kind: "wallet_topup", wallet: PREPAID.id, apply_to_merchant: true }, cookie));
		expect(all.status).toBe(400);
		const b = await json(await send(post("/api/lines/hg-200/kind", { kind: "wallet_topup", wallet: PREPAID.id, apply_to_merchant: false }, cookie)));
		expect(b).toMatchObject({ ok: true, scope: "line", changed: 1, line: { kind: "transfer", spending: false } });
		expect(balance(PREPAID.id, 0)).toBe(20000);
	});
});

describe("ledger_add_cash with account sample-bistro: a meal paid from the card", () => {
	it("in Food unless he names another category; the balance goes down; counted as spending once", async () => {
		await citi();
		await tool("ledger_set_kind", { kind: "wallet_topup", wallet: "sample-bistro", line_id: "hg-200" });
		const r = await tool("ledger_add_cash", { account: "sample-bistro", date: "2026-10-20", amount: "18.50", merchant: "Sample Bistro" });
		expect(r.message).toBeUndefined();
		expect(r.already_recorded).toBe(false);
		expect(r.line).toMatchObject({ account: { id: PREPAID.id }, category: "Food", amount: { home: { minor: 1850 } }, spending: true, flags: [] });
		const drink = await tool("ledger_add_cash", { account: "Sample Bistro", date: "2026-10-20", amount: "4.00", merchant: "Sample Bistro", category: "Drinks" });
		expect(drink.line).toMatchObject({ category: "Drinks" });
		expect(spend()).toBe(1850 + 400);
		expect(balance(PREPAID.id, 0)).toBe(20000 - 1850 - 400); // 17750
		expect(lines().some((l) => l.kind === "wallet_offset")).toBe(false);
		const q = await tool("ledger_query", { account: "sample-bistro" });
		const cov = (q.coverage as { account_id: string; message: string; wallet: { balance: { minor: number } } }[]).find((c) => c.account_id === PREPAID.id)!;
		expect(cov.message).toBe("Sample Bistro 儲值卡：餘額只算你告訴我的消費");
		expect(cov.wallet.balance.minor).toBe(17750);
	});

	it("below zero: recorded, and flagged needs_review with a plain note", async () => {
		const r = await tool("ledger_add_cash", { account: "sample-bistro", date: "2026-10-20", amount: "12.00", merchant: "Sample Bistro" });
		expect(r.ok).toBe(true);
		expect(r.line.flags).toContain("needs_review");
		expect(r.line.note).toContain("儲值還沒記到");
		expect(balance(PREPAID.id, 0)).toBe(-1200);
	});

	it("no default category when his list does not have it: left for the usual sorting, never invented", async () => {
		env = makeEnv(withLikeCap(raw), { LEDGER_CATEGORIES: "Dining, Others" });
		const r = await tool("ledger_add_cash", { account: "sample-bistro", date: "2026-10-20", amount: "5.00", merchant: "Sample Bistro" });
		expect(r.line.category).toBeNull();
	});
});

describe("the page reads a wallet (19 Oct 2026, the owner: \"where do I see that I spent this money?\")", () => {
	it("GET /api/wallets: balance 240 − 15.74 = 224.26 credit, worth 200.00 − round(200 × 15.74 / 240) = S$186.88; GET /api/lines: the top-up pair carries topup on both legs; 帳戶 lists the card", async () => {
		await citi();
		await tool("ledger_set_kind", { kind: "wallet_topup", wallet: "sample-bistro", line_id: "hg-200", credit: "240" });
		await tool("ledger_add_cash", { account: "sample-bistro", date: "2026-10-19", amount: "15.74", merchant: "Sample Bistro" });
		const cookie = await signedIn();
		const send = (r: Request) => handleRequest(r, env, CTX, app);
		const w = await json(await send(get("/api/wallets", cookie)));
		expect(w.ok).toBe(true);
		const hg = (w.wallets as Record<string, any>[]).find((x) => x.account.id === PREPAID.id)!;
		expect(hg).toMatchObject({ balance: { minor: 22426 }, remaining_value: { minor: 18688 }, bonus: true, uses_count: 1, used: { cost: { minor: 1312 }, counted_now: { minor: 1312 } } });
		expect(hg.lots).toEqual([expect.objectContaining({ kind: "topup", from: expect.objectContaining({ id: "card-c" }), credit: "240.00", left: "224.26" })]);
		const l = await json(await send(get("/api/lines?from=2026-10-19&to=2026-10-19&limit=50", cookie)));
		const pair = (l.lines as Record<string, any>[]).filter((x) => x.topup);
		expect(pair.map((x) => x.topup.role).sort()).toEqual(["source", "wallet"]);
		expect(pair.find((x) => x.id === "hg-200")!.topup).toMatchObject({ role: "source", credit: "240.00", paid: { minor: 20000 } });
		const o = await json(await send(get("/api/overview?month=2026-10", cookie)));
		expect((o.by_account as { account_id: string }[]).map((g) => g.account_id)).toEqual(expect.arrayContaining([PREPAID.id, WALLET.id]));
		const cov = (o.coverage as Record<string, any>[]).find((c) => c.account_id === PREPAID.id)!;
		expect(cov.wallet).toMatchObject({ balance: { minor: 22426 }, remaining_value: { minor: 18688 } });
	});
});
