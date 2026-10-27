/// GrabPay (14 Oct 2026): Grab's own mail is the wallet's source of
/// truth — and only the wallet's. Made-up mail, a made-up Claude, made-up
/// amounts; the wallet is the made-up one in test/helpers/fixtures.ts
/// (recorded from 2026-10-14 with S$42.00 already counted at top-up).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../../src/db";
import { ingestEvidence } from "../../src/engine";
import type { LineRow } from "../../src/types";
import { totals } from "../../src/views";
import { WALLET } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts, testEngine } from "../../test/helpers/world";
import { walletAuthenticated } from "../src/banks";
import type { Ctx, LedgerEnv } from "../src/env";
import { handleMcp } from "../src/mcp";
import { workQueue } from "../src/pipeline";
import { GRAB_NOTES, grabFromAnswer, grabPrompt, systemPrompt } from "../src/read";
import type { GrabAnswer } from "../src/schemas";
import type { WalletAccount } from "../../src/wallet";
import { estimateTokens, NEXT_TOKEN_BUDGET, schemaJson } from "../src/reader";
import { GrabSchema } from "../src/schemas";
import { runTick, type Services } from "../src/tick";
import { bigPlaybook } from "./helpers/big-playbook";
import { FakeClaude, MODELS, type Call } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { BASE, makeDeps, makeEnv, OWNER, seedWorld } from "./helpers/harness";

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
beforeEach(async () => {
	db = freshDb();
	D = makeDeps("2026-10-14T14:00:00.000Z");
	await addAccounts(db);
	await insertRow(db, "accounts", WALLET).run();
});
afterEach(() => db.close());

const CATEGORIES = { LEDGER_CATEGORIES: "Food, Drinks, Grab/Uber, Supermarket, Others" };
const tick = (svc: Services) => runTick(makeEnv(db, { ...MODELS, ...CATEGORIES }), D, svc, [workQueue]);
function queue(...ids: string[]) {
	for (const id of ids) db.raw.prepare("INSERT INTO work (gmail_id, source, stage, attempts, created_at, updated_at) VALUES (?, 'daily', 'new', 0, 'x', 'x')").run(id);
}
const lines = () => db.raw.prepare("SELECT * FROM lines WHERE state <> 'void' ORDER BY created_at, id").all() as unknown as LineRow[];
const evidence = () => db.raw.prepare("SELECT type, line_id, amount_minor, merchant_raw FROM evidence ORDER BY created_at").all() as { type: string; line_id: string | null; amount_minor: number; merchant_raw: string }[];
const alarms = () => (db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL ORDER BY key").all() as { key: string }[]).map((a) => a.key);

const entry = (over: Record<string, unknown> = {}) => ({ date: "2026-10-14", time: "15:02", description: "Test Tea House", service: "drinks", direction: "out", currency: "SGD", amount: "5.44", paid_with: "grabpay_wallet", card_last4: null, order_id: "GF-TEST-1", items: ["Brown sugar milk tea"], ...over });
const receiptAnswer = (over: Record<string, unknown> = {}) => ({ is_money: true, document: "receipt", period_start: null, period_end: null, opening_balance: null, closing_balance: null, entries: [entry(over)], confidence: "sure", note: "" });
const grabMail = (id: string, over: Partial<Parameters<typeof mail>[0]> = {}) => mail({ id, from: "Grab <no-reply@grab.com>", subject: "Your Grab E-Receipt", text: "GrabFood order GF-TEST-1. Total S$5.44. Paid with GrabPay Wallet.", ...over });

describe("whose mail counts as Grab's", () => {
	it("grab.com and its sub-domains, when Gmail vouches for Grab — never a lookalike or someone else's signature", () => {
		expect(walletAuthenticated("no-reply@grab.com", ["grab.com"])).toBe("grab");
		expect(walletAuthenticated("statements@mail.grab.com", ["grab.com"])).toBe("grab");
		expect(walletAuthenticated("no-reply@grab.com", [])).toBeNull(); // spoofed: nothing passed
		expect(walletAuthenticated("no-reply@grab.com", ["sendgrid.net"])).toBeNull(); // someone else's signature
		expect(walletAuthenticated("no-reply@grab.com.evil.example", ["grab.com.evil.example"])).toBeNull();
		expect(walletAuthenticated("no-reply@grab-mail.com", ["grab-mail.com"])).toBeNull();
		expect(walletAuthenticated("no-reply@notgrab.com", ["notgrab.com"])).toBeNull();
	});
});

describe("a Grab e-receipt", () => {
	it("paid from the GrabPay wallet: a provisional wallet line in its category, and the pre-counted balance offsets it", async () => {
		const g = new FakeGmail().add(grabMail("g1"));
		const claude = new FakeClaude(() => receiptAnswer());
		queue("g1");
		await tick({ gmail: g, claude }); // sorted as a receipt: waits behind the bank's mail
		await tick({ gmail: g, claude });
		expect(claude.calls).toHaveLength(1);
		expect(claude.calls[0]!.system.split("\n")[0]).toContain("may be a receipt");
		expect(claude.calls[0]!.user.startsWith(GRAB_NOTES)).toBe(true);
		expect(claude.calls[0]!.user).toMatch(/<email-[0-9a-f]{24}>/);
		const [drink, offset] = lines();
		expect(drink).toMatchObject({ account_id: WALLET.id, kind: "purchase", category: "Drinks", home_minor: 544, statement_id: null, merchant_raw: "Test Tea House" });
		expect(offset).toMatchObject({ kind: "wallet_offset", offset_of: drink!.id, home_minor: -544, category: "Grab/Uber" });
		expect(totals(lines()).spending_home.minor).toBe(0);
		expect(evidence()).toMatchObject([{ type: "alert", line_id: drink!.id, amount_minor: 544 }]);
	});

	it("paid by card: an ordinary receipt — it finds the card's own line and adds nothing", async () => {
		const e = testEngine(db);
		const card = await ingestEvidence(e, { type: "alert", institution: "hsbc", last4: "1111", authenticated: true, fingerprint: "c1", txn_date: "2026-10-14", currency: "SGD", amount_minor: 1280, merchant_raw: "GRAB* A-7F3K2 SINGAPORE SG", kind_hint: "purchase" });
		const g = new FakeGmail().add(grabMail("g2", { text: "GrabCar ride. Total S$12.80. Paid with Mastercard ending 1111." }));
		const claude = new FakeClaude(() => receiptAnswer({ description: "GrabCar", service: "ride", amount: "12.80", paid_with: "card", card_last4: "1111", order_id: "A-7F3K2", items: [] }));
		queue("g2");
		await tick({ gmail: g, claude });
		await tick({ gmail: g, claude });
		expect(lines()).toHaveLength(1);
		expect(lines()[0]).toMatchObject({ account_id: "card-a", kind: "purchase", home_minor: 1280 });
		expect(evidence().map((x) => [x.type, x.line_id])).toEqual([
			["alert", (card as { line_id: string }).line_id],
			["receipt", (card as { line_id: string }).line_id],
		]);
	});

	it("a spoofed Grab sender can make no line, whatever it says — and the owner is told", async () => {
		const g = new FakeGmail().add(
			grabMail("s1", { auth: [] }), // claims grab.com, nothing passed
			grabMail("s2", { from: "Grab <no-reply@grab.com.evil.example>" }), // passes, for its OWN domain
		);
		// Whatever the reader is asked, it answers "wallet paid" — it must not matter.
		const claude = new FakeClaude((c: Call) =>
			c.user.startsWith(GRAB_NOTES) ? receiptAnswer() : { is_receipt: true, merchant: "Test Tea House", currency: "SGD", amount: "5.44", direction: "out", date: "2026-10-14", order_id: null, items: [], flights: [], hotels: [], confidence: "sure", note: "" },
		);
		queue("s1", "s2");
		await tick({ gmail: g, claude });
		await tick({ gmail: g, claude });
		expect(claude.calls).toHaveLength(2);
		expect(claude.calls.every((c) => !c.user.startsWith(GRAB_NOTES))).toBe(true); // read as ordinary receipts
		expect(lines()).toEqual([]);
		expect(evidence().map((x) => x.type)).toEqual(["receipt", "receipt"]);
		expect(evidence().every((x) => x.line_id === null)).toBe(true);
		expect(alarms()).toEqual(["wallet_unverified:GRAB"]);
	});
});

describe("the GrabPay Wallet transaction statement", () => {
	it("creates and confirms the wallet's lines, and the day reconciles to the cent", async () => {
		const statement = {
			is_money: true,
			document: "wallet_statement",
			period_start: "2026-10-14",
			period_end: "2026-10-14",
			opening_balance: "42.00",
			closing_balance: "56.56",
			entries: [entry(), entry({ description: "Top up", service: "topup", direction: "in", amount: "20.00", order_id: null, items: [] })],
			confidence: "sure",
			note: "",
		};
		const g = new FakeGmail().add(grabMail("st1", { subject: "Your GrabPay Wallet statement", text: "Opening 42.00 ... Closing 56.56" }));
		const claude = new FakeClaude(() => statement);
		queue("st1");
		await tick({ gmail: g, claude });
		await tick({ gmail: g, claude });
		const s = db.raw.prepare("SELECT account_id, recon_status, opening_balance_minor, closing_balance_minor FROM statements").get();
		// 4200 − 544 + 2000 = 5656: the printed closing.
		expect(s).toEqual({ account_id: WALLET.id, recon_status: "reconciled", opening_balance_minor: 4200, closing_balance_minor: 5656 });
		const wallet = lines().filter((l) => l.kind !== "wallet_offset");
		expect(wallet.map((l) => [l.kind, l.bill_minor, l.category])).toEqual([
			["purchase", 544, "Drinks"],
			["transfer", -2000, null],
		]);
		expect(totals(lines()).spending_home.minor).toBe(0);
	});
});

describe("what a Grab reading may do is decided in code", () => {
	const W = WALLET as WalletAccount;
	const from = { id: "m1", from: "Grab <no-reply@grab.com>" };
	it("a statement reaching back before the cut-over keeps only the wallet's own days, and no longer claims its printed balances", () => {
		const a = { is_money: true, document: "wallet_statement", period_start: "2026-10-13", period_end: "2026-10-14", opening_balance: "45.00", closing_balance: "36.56", entries: [entry({ date: "2026-10-13", amount: "5.21", order_id: "o-old" }), entry()], confidence: "sure", note: "" } as GrabAnswer;
		const r = grabFromAnswer(a, from, W, ["Drinks"]);
		if (r.kind !== "statement") throw new Error(r.kind);
		expect(r.skipped).toBe(1);
		expect(r.read[0]!.st).toMatchObject({ account_id: W.id, period_start: "2026-10-14", opening_balance_minor: null, closing_balance_minor: null });
		expect(r.read[0]!.lines.map((l) => [l.txn_date, l.amount_minor, l.category])).toEqual([["2026-10-14", 544, "Drinks"]]);
	});
	it("whatever the email says, the account is the wallet the code names — and a card-paid order is only a receipt", () => {
		const wallet = grabFromAnswer(receiptAnswer() as GrabAnswer, from, W, ["Drinks"]);
		expect(wallet).toMatchObject({ kind: "evidence", as: "alert", ev: { account_id: W.id, institution: "grab", category: "Drinks" } });
		const card = grabFromAnswer(receiptAnswer({ paid_with: "card", card_last4: "1111" }) as GrabAnswer, from, W, ["Drinks"]);
		expect(card).toMatchObject({ kind: "evidence", as: "receipt", ev: { type: "receipt" } });
		expect((card as { ev: { account_id?: string } }).ev.account_id).toBeUndefined();
		expect(grabFromAnswer({ ...(receiptAnswer() as GrabAnswer), is_money: false }, from, W, [])).toMatchObject({ kind: "ignored" });
	});
	it("a Traditional Chinese list works as the English one does: a GrabFood order is 餐飲, a drink 飲料, GrabMart 超市, a ride Grab/Uber", () => {
		// The zh-Hant starting list (src/words/zh-Hant.ts "categories.default"), written out by hand.
		const zh = ["餐飲", "超市", "飲料", "交通", "Grab/Uber", "購物", "服飾", "娛樂", "訂閱", "醫療", "保險", "房租", "水電", "禮物", "旅行", "其他"];
		const cat = (service: string) => (grabFromAnswer(receiptAnswer({ service }) as GrabAnswer, from, W, zh) as { ev: { category: string | null } }).ev.category;
		expect([cat("food"), cat("drinks"), cat("mart"), cat("ride")]).toEqual(["餐飲", "飲料", "超市", "Grab/Uber"]);
		// A service whose category is not on the list gets none (the owner's list decides).
		expect((grabFromAnswer(receiptAnswer({ service: "food" }) as GrabAnswer, from, W, ["其他"]) as { ev: { category: string | null } }).ev.category).toBeNull();
	});
});

describe("The owner's word through the Ledger connector", () => {
	it("ledger_add_cash with account grabpay records today's S$5.44 drink from the wallet, in Drinks, not counted twice", async () => {
		const raw = freshDb();
		await seedWorld(raw);
		await insertRow(raw, "accounts", WALLET).run();
		const env: LedgerEnv = makeEnv(raw);
		const deps = makeDeps("2026-10-14T08:00:00.000Z");
		const ctx: Ctx = { waitUntil() {}, props: { email: OWNER } };
		const call = async (args: Record<string, unknown>) => {
			const res = await handleMcp(
				new Request(`${BASE}/mcp`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ledger_add_cash", arguments: args } }),
				}),
				env,
				ctx,
				deps,
			);
			const r = (await res.json()) as { result: { content: { text: string }[] } };
			return JSON.parse(r.result.content[0]!.text) as { ok: boolean; message?: string; already_recorded?: boolean; line: { account: { id: string }; category: string; amount: { home: { minor: number } }; wallet: { message: string } | null } };
		};
		const r = await call({ account: "grabpay", date: "2026-10-14", amount: "5.44", merchant: "GrabFood - Test Tea House", category: "Drinks" });
		expect(r.message).toBeUndefined();
		expect(r.ok).toBe(true);
		expect(r.already_recorded).toBe(false);
		expect(r.line).toMatchObject({ account: { id: WALLET.id }, category: "Drinks", amount: { home: { minor: 544 } } });
		expect(r.line.wallet?.message).toContain("儲值時已算過");
		const walletLines = raw.raw.prepare("SELECT kind, home_minor FROM lines WHERE account_id = ? AND state <> 'void' ORDER BY kind").all(WALLET.id);
		expect(walletLines).toEqual([
			{ kind: "purchase", home_minor: 544 },
			{ kind: "wallet_offset", home_minor: -544 },
		]);
		// The field may be called account_id too: never silently cash.
		const again = await call({ account_id: "grabpay", date: "2026-10-14", amount: "3.00", merchant: "GrabFood - Test Bakery", category: "Food" });
		expect(again.line.account.id).toBe(WALLET.id);
		// A bank account is never the owner's to add by hand (a card is, since 21 Oct: mcp.test.ts).
		expect((await call({ account: "bank-x", amount: "5.00", merchant: "x" })).ok).toBe(false);
		raw.close();
	});
});

describe("a Grab reading fits what the reader routine can open", () => {
	it("the receipt instructions, a long Grab email and the Grab schema stay well inside one reader_next", () => {
		const head = { version: 115, body: bigPlaybook(), body_sha256: "x", created_at: "x" };
		const long = mail({ id: "big", from: "Grab <no-reply@grab.com>", subject: "Your GrabPay Wallet statement", text: "14 Oct 2026  GrabFood Test Tea House  -5.44\n".repeat(2000) });
		const tokens = estimateTokens(systemPrompt("receipt", head)) + estimateTokens(grabPrompt(long)) + estimateTokens(schemaJson(GrabSchema));
		expect(tokens).toBeLessThan(NEXT_TOKEN_BUDGET);
	});
});
