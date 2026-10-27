/// POST /api/shortcut/sms and the prepaid bonus through the worker (19 Oct
/// 2026): the made-up 範例 card (test/helpers/fixtures.ts DEMO, with a sample
/// SMS in RestoSuite's format) and the Sample Bistro card
/// (PREPAID). The SMS is untrusted: it can only reach the one wallet whose own
/// data names it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../../src/db";
import { line, PREPAID, WALLET, DEMO, DEMO_SMS } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts, put, testEngine } from "../../test/helpers/world";
import { ingestEvidence } from "../../src/engine";
import { handleRequest, type App } from "../src/app";
import type { Ctx, LedgerEnv } from "../src/env";
import { handleMcp } from "../src/mcp";
import { walletSms } from "../src/sms";
import { runTick } from "../src/tick";
import { FakeClaude, MODELS, type Call } from "./helpers/fake-claude";
import { BASE, CTX, json, makeDeps, makeEnv, OWNER, post, signedIn, TAP_KEY, TEST_ASSETS, UNLOCK_KEY, withLikeCap } from "./helpers/harness";

let raw: TestDb;
let env: LedgerEnv;
let app: App & { deps: ReturnType<typeof makeDeps> };
beforeEach(async () => {
	raw = freshDb();
	await addAccounts(raw);
	for (const a of [WALLET, PREPAID, DEMO]) await insertRow(raw, "accounts", a).run();
	env = makeEnv(withLikeCap(raw), { LEDGER_CATEGORIES: "Food, Drinks, Grab/Uber, Others" });
	// 2026-10-19 21:30 in Singapore
	app = { assets: TEST_ASSETS, deps: makeDeps("2026-10-19T13:30:00.000Z") };
});
afterEach(() => raw.close());

const send = (r: Request) => handleRequest(r, env, CTX, app);
const auth = (key = TAP_KEY) => ({ Authorization: `Bearer ${key}` });
const j = async (r: Response | Promise<Response>) => (await json(await r)) as Record<string, any>;
const sms = (body: unknown, key = TAP_KEY) => send(post("/api/shortcut/sms", body, undefined, auth(key)));
const rows = () => raw.raw.prepare("SELECT * FROM wallet_sms ORDER BY received_at, id").all() as Record<string, any>[];
const lines = () => raw.raw.prepare("SELECT * FROM lines WHERE state <> 'void' ORDER BY created_at, id").all() as Record<string, any>[];
const xLines = () => lines().filter((l) => l.account_id === DEMO.id);

describe("the SMS endpoint's key", () => {
	it("no key, a wrong key, the page's unlock key or the page's cookie: 401, nothing written", async () => {
		for (const headers of [{}, auth("wrong"), auth(UNLOCK_KEY), { Authorization: TAP_KEY }]) {
			const res = await send(post("/api/shortcut/sms", { text: DEMO_SMS, sender: "RestoSuite" }, undefined, headers));
			expect(res.status).toBe(401);
			expect(await json(res)).toEqual({ ok: false, message: "not authorised" });
		}
		expect((await send(post("/api/shortcut/sms", { text: DEMO_SMS, sender: "RestoSuite" }, await signedIn()))).status).toBe(401);
		expect(rows()).toHaveLength(0);
		expect(lines()).toHaveLength(0);
	});

	it("a body that is not an SMS is a 400 with a reason", async () => {
		expect((await sms("{garbage")).status).toBe(400);
		expect(await j(sms({ sender: "RestoSuite" }))).toMatchObject({ ok: false, message: "沒有簡訊內容（text）" });
		expect((await sms({ text: DEMO_SMS, sender: "RestoSuite", date: "18/10/2026" })).status).toBe(400);
		expect((await sms({ text: DEMO_SMS, sender: "RestoSuite", date: "2026-10-25" })).status).toBe(400); // not yet
	});
});

describe("The owner's 範例 SMS", () => {
	it("the sample SMS, dated 2026-10-18: recorded at once (no reading needed) — 「已記下：範例 儲值卡 −$31.40（實際 SGD 26.91），餘額 257.48」", async () => {
		const res = await sms({ text: DEMO_SMS, sender: "RestoSuite", date: "2026-10-18" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Record<string, any>;
		expect(body).toMatchObject({ ok: true, status: "done", message: "已記下：範例 儲值卡 −$31.40（實際 SGD 26.91），餘額 257.48" });
		expect(xLines().map((l) => [l.kind, l.txn_date, l.bill_minor, l.home_minor])).toEqual([
			["purchase", "2026-10-18", 3140, 2691],
			["wallet_offset", "2026-10-18", -2691, -2691],
		]);
		expect(rows()[0]).toMatchObject({ state: "done", check_state: "ok", text: "" });
		const ev = raw.raw.prepare("SELECT type FROM evidence WHERE line_id = ?").all(String(body.line_id)) as { type: string }[];
		expect(ev.map((x) => x.type)).toEqual(["sms"]);
	});

	it("the same SMS sent twice (the Shortcut ran twice) is recorded once", async () => {
		await sms({ text: DEMO_SMS, sender: "RestoSuite", date: "2026-10-18" });
		app.deps.advance(70_000); // into the next minute: the minute before still counts
		const again = await j(sms({ text: DEMO_SMS, sender: "RestoSuite", date: "2026-10-18" }));
		expect(again).toMatchObject({ ok: true, status: "duplicate" });
		expect(again.message).toContain("已記下");
		expect(rows()).toHaveLength(1);
		expect(xLines().filter((l) => l.kind === "purchase")).toHaveLength(1);
	});

	it("no date: the Singapore day it arrived", async () => {
		await sms({ text: DEMO_SMS, sender: "RestoSuite" });
		expect(xLines()[0]!.txn_date).toBe("2026-10-19");
	});

	it("RestoSuite texting for another restaurant, a stranger using its words, or no sender: ignored — nothing written, no account touched", async () => {
		for (const body of [
			{ text: "【OTHER PLACE】您的卡*1111在别的餐厅,消费卡值: $20.00,卡余额:$80.00", sender: "RestoSuite" },
			{ text: DEMO_SMS, sender: "+6512345678" },
			{ text: DEMO_SMS },
			{ text: "SAMPLE BISTRO 消费卡值: $20.00,卡余额:$80.00", sender: "RestoSuite" },
		]) {
			const r = await j(sms(body));
			expect(r).toMatchObject({ ok: true, status: "ignored" });
		}
		expect(rows()).toHaveLength(0);
		expect(lines()).toHaveLength(0);
	});

	it("a balance that differs reaches 待確認 with its two answers, and 「用簡訊的餘額」 makes one adjustment line", async () => {
		await sms({ text: DEMO_SMS.replace("257.48", "250.00"), sender: "RestoSuite", date: "2026-10-18" });
		const cookie = await signedIn();
		const ok = await j(send(new Request(`${BASE}/api/needs-ok`, { headers: { Cookie: cookie } })));
		expect(ok.wallet_sms).toHaveLength(1);
		expect(ok.wallet_sms[0].title).toBe("範例 儲值卡 簡訊餘額 250.00，帳本算出 257.48");
		const accept = ok.wallet_sms[0].actions.find((a: { id: string }) => a.id === "accept");
		const r = await j(send(post(accept.path, accept.body, cookie)));
		expect(r).toMatchObject({ ok: true, message: "已照簡訊調整：範例 儲值卡 餘額 250.00" });
		expect(r.line.amount.original.minor).toBe(748);
		const after = await j(send(new Request(`${BASE}/api/needs-ok`, { headers: { Cookie: cookie } })));
		expect(after.wallet_sms).toEqual([]);
	});

	it("a format the ledger does not know waits for the reading desk ('已收到，讀取中'), then the reader's answer is recorded", async () => {
		const text = "【DEMO NOODLE】Thank you! Card *5509 used S$12.00 today. Remaining value S$245.65";
		expect(await j(sms({ text, sender: "RestoSuite", date: "2026-10-19" }))).toMatchObject({ ok: true, status: "reading", message: "已收到，讀取中" });
		expect(rows()[0]).toMatchObject({ state: "reading" });
		const claude = new FakeClaude((c: Call) => {
			expect(c.user).toContain("LEDGER NOTES");
			expect(c.user).toContain(text); // inside the fence, as data
			return { kind: "spend", amount_spent: "12.00", balance_left: "245.65", confidence: "sure", note: "" };
		});
		const r = await runTick(makeEnv(withLikeCap(raw), { ...MODELS, LEDGER_CATEGORIES: "Food, Others" }), app.deps, { claude }, [walletSms]);
		expect(r.errors).toEqual([]);
		expect(claude.calls).toHaveLength(1);
		expect(rows()[0]).toMatchObject({ state: "done", spent_minor: 1200, balance_minor: 24565 });
		// 288.88 − 12.00 = 276.88 in the ledger (no earlier meal told): the SMS says 245.65 → 待確認.
		expect(rows()[0]).toMatchObject({ ledger_balance_minor: 27688, check_state: "mismatch" });
		expect(xLines().find((l) => l.kind === "purchase")).toMatchObject({ bill_minor: 1200, txn_date: "2026-10-19", category: "Food" });
	});
});

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
const citi = (id = "hg-200", minor = 20000) =>
	put(raw, "lines", line({ id, account_id: "card-c", kind: "purchase", txn_date: "2026-10-19", merchant_raw: "SAMPLE BISTRO         SINGAPORE", merchant_key: "SAMPLE BISTRO", merchant_name: "Sample Bistro", orig_minor: minor, bill_minor: minor, home_minor: minor }));
const balance = (id: string, opening: number) => opening - lines().filter((l) => l.account_id === id && l.kind !== "wallet_offset").reduce((s, l) => s + l.bill_minor, 0);

describe("the bonus by the owner's word: connector and page", () => {
	it("ledger_set_kind wallet_topup with credit 240: balance 240.00; a 24 meal by ledger_add_cash is S$20.00", async () => {
		await citi();
		const r = await tool("ledger_set_kind", { kind: "wallet_topup", wallet: "sample-bistro", line_id: "hg-200", credit: "240" });
		expect(r.ok).toBe(true);
		expect(balance(PREPAID.id, 0)).toBe(24000);
		const m = await tool("ledger_add_cash", { account: "sample-bistro", amount: "24", date: "2026-10-19", merchant: "Sample Bistro" });
		expect(m.line.amount.original.minor).toBe(2400);
		expect(m.line.amount.home.minor).toBe(2000);
		expect(m.line.category).toBe("Food");
		expect(balance(PREPAID.id, 0)).toBe(21600);
	});

	it("a credit that cannot be right is refused in plain words", async () => {
		await citi();
		const r = await tool("ledger_set_kind", { kind: "wallet_topup", wallet: "sample-bistro", line_id: "hg-200", credit: "24" });
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/比付的錢/);
	});

	it("the page's 「儲值到…」 sends the credit; 待確認's 「這次儲值有送嗎？」 takes one", async () => {
		await citi();
		const cookie = await signedIn();
		const r = await j(send(post("/api/lines/hg-200/kind", { kind: "wallet_topup", wallet: PREPAID.id, credit: "240.00" }, cookie)));
		expect(r.ok).toBe(true);
		expect(balance(PREPAID.id, 0)).toBe(24000);
		// An automatic one (round S$100 by the rule) asks.
		await ingestEvidence(testEngine(raw), { type: "alert", institution: "citi", last4: "3333", authenticated: true, fingerprint: "auto-100", txn_date: "2026-10-19", currency: "SGD", amount_minor: 10000, merchant_raw: "SAMPLE BISTRO SINGAPORE", kind_hint: "purchase" });
		const ok = await j(send(new Request(`${BASE}/api/needs-ok`, { headers: { Cookie: cookie } })));
		expect(ok.wallet_topups).toHaveLength(1);
		const give = ok.wallet_topups[0].actions.find((a: { id: string }) => a.id === "credit");
		const ans = await j(send(post(give.path, { ...give.body, credit: "120" }, cookie)));
		expect(ans).toMatchObject({ ok: true });
		expect(ans.message).toContain("120.00");
		expect(balance(PREPAID.id, 0)).toBe(24000 + 12000);
		const after = await j(send(new Request(`${BASE}/api/needs-ok`, { headers: { Cookie: cookie } })));
		expect(after.wallet_topups).toEqual([]);
	});
});
