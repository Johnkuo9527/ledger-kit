/// An owner who chose English (LEDGER_LANGUAGE = "en") never reads a Chinese
/// character the ledger wrote: not on any page read, not in an alarm, not in a
/// reply to the page, the iPhone Shortcuts or the connector (src/words.ts).
///
/// What the OWNER wrote, or a shop or bank sent, is data and stays as it is: the
/// world below holds Chinese data on purpose (a merchant, an account name, a
/// shop's SMS), and the sweep allows exactly those values — in a data field, or
/// quoted inside one of the ledger's sentences — and nothing else.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertRow } from "../../src/db";
import { DEMO, line, PREPAID, WALLET } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { put } from "../../test/helpers/world";
import { handleRequest } from "../src/app";
import type { Ctx } from "../src/env";
import { handleMcp } from "../src/mcp";
import { lockedMessage } from "../src/pdf-locks";
import { silenceMessage } from "../src/silence";
import { googleSigninMessage } from "../src/tick";
import { setLanguage } from "../../src/words";
import { BASE, CTX, makeDeps, makeEnv, OWNER, post, seedYear, signedIn, TAP_KEY, TEST_ASSETS, YEAR_CATEGORIES, get } from "./helpers/harness";

const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;
const AT = "2026-10-20T08:00:00.000Z";

/// The Chinese DATA in this world: the owner's own names and a shop's SMS.
const MERCHANT = "鼎泰豐";
const ACCOUNT = "我的卡";
const SHOP_SMS = "【DEMO NOODLE】您的卡*5509在範例麵館 @ 101,消费卡值: $31.40,卡余额:$250.00";
/// (The made-up prepaid cards are named in Chinese too: "Sample Bistro 儲值卡" …)
const DATA_VALUES = [MERCHANT, ACCOUNT, SHOP_SMS, WALLET.name, PREPAID.name, DEMO.name];
/// Fields that only ever hold data (names, notes, raw statement text, file names).
const DATA_KEYS = new Set(["name", "merchant", "raw", "merchant_name", "merchant_raw", "note", "category", "categories", "filename", "account", "card", "wallet_names", "key", "text", "was"]);

/// Every string the ledger wrote in this answer that still has a Chinese character
/// once the allowed data is taken out of it, with where it sits.
function chinese(value: unknown, at = "$", key = ""): string[] {
	if (typeof value === "string") {
		if (DATA_KEYS.has(key)) return [];
		const left = DATA_VALUES.reduce((s, d) => s.split(d).join(""), value);
		return CJK.test(left) ? [`${at}: ${value.slice(0, 160)}`] : [];
	}
	if (Array.isArray(value)) return value.flatMap((v, i) => chinese(v, `${at}[${i}]`, key));
	if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => chinese(v, `${at}.${k}`, k));
	return [];
}

let raw: TestDb;
let cookie: string;
const env = () => makeEnv(raw, { LEDGER_LANGUAGE: "en", LEDGER_CATEGORIES: YEAR_CATEGORIES.join(", ") });
const deps = makeDeps(AT);
const app = () => ({ assets: TEST_ASSETS, deps });
const send = (r: Request) => handleRequest(r, env(), CTX, app());
const replies: { what: string; body: unknown }[] = [];
async function answer(what: string, r: Request): Promise<unknown> {
	const res = await send(r);
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* a plain-text Shortcut reply */
	}
	replies.push({ what, body });
	return body;
}
const shortcut = (path: string, body: unknown) => post(path, body, undefined, { Authorization: `Bearer ${TAP_KEY}` });

beforeAll(async () => {
	raw = freshDb();
	await seedYear(raw);
	cookie = await signedIn(new Date(AT));
	for (const w of [WALLET, PREPAID, DEMO]) await insertRow(raw, "accounts", w).run();
	raw.raw.prepare("UPDATE accounts SET name = ? WHERE id = 'card-b'").run(ACCOUNT);
	// Chinese data: a merchant the bank printed, on a card the owner named in Chinese.
	await put(raw, "lines", line({ id: "zh-data", account_id: "card-b", txn_date: "2026-10-12", merchant_raw: MERCHANT, merchant_key: MERCHANT, merchant_name: MERCHANT, orig_minor: 4200, bill_minor: 4200, home_minor: 4200, state: "review" }));
	// A top-up of a prepaid card the rules paired, with no answer yet about its bonus (to review asks).
	await put(raw, "lines", line({ id: "zh-topup", account_id: "card-c", kind: "transfer", transfer_group: "tg-zh", txn_date: "2026-10-19", merchant_raw: "SAMPLE BISTRO SINGAPORE", merchant_key: "SAMPLE BISTRO", merchant_name: "Sample Bistro", orig_minor: 20000, bill_minor: 20000, home_minor: 20000 }));
	await put(raw, "lines", line({ id: "zh-topup-leg", account_id: "wallet-hg", kind: "transfer", transfer_group: "tg-zh", counter_account_id: "card-c", txn_date: "2026-10-19", merchant_raw: "Top-up", merchant_name: "Top-up", orig_minor: -20000, bill_minor: -20000, home_minor: -20000 }));
	setLanguage("en"); // the replies below are made in the owner's language; the alarms are written in it too
	await put(raw, "lines", line({ id: "zh-topup-2", account_id: "card-a", txn_date: "2026-10-19", merchant_raw: "SAMPLE BISTRO SINGAPORE", merchant_key: "SAMPLE BISTRO", merchant_name: "Sample Bistro", orig_minor: 10000, bill_minor: 10000, home_minor: 10000 }));
	await answer("top-up", post("/api/lines/zh-topup-2/kind", { kind: "wallet_topup", wallet: "sample-bistro", credit: "120" }, cookie));
	await answer("cash on a prepaid card", post("/api/cash", { date: "2026-10-19", amount: "31.40", currency: "SGD", merchant: "Demo Noodle", account_id: "wallet-xx" }, cookie));
	// A shop's SMS whose balance differs from the ledger's, and one the ledger cannot read yet.
	await answer("sms (known format)", shortcut("/api/shortcut/sms", { text: SHOP_SMS, sender: "RestoSuite", date: "2026-10-19" }));
	await answer("sms (unknown format)", shortcut("/api/shortcut/sms", { text: "DEMO NOODLE thanks you", sender: "RestoSuite", date: "2026-10-19" }));
	raw.raw.prepare("UPDATE wallet_sms SET state = 'failed', text = 'DEMO NOODLE thanks you' WHERE state = 'reading'").run();
	await answer("sms (no text)", shortcut("/api/shortcut/sms", { sender: "RestoSuite" }));
	// Taps: one from a card the ledger does not know (held), and its reply.
	await answer("tap", shortcut("/api/shortcut/tap", { card: "Unknown Card", merchant: "Noodle Bar", amount: "S$7.80", timestamp: "2026-10-19T12:30:00+08:00" }));
	// Statement uploads that end in every state that waits on the owner.
	const pdf = (n: number) => new Uint8Array([...new TextEncoder().encode(`%PDF-1.4\n% made-up ${n}\n`)]);
	for (const n of [1, 2, 3]) {
		const f = new FormData();
		f.append("files", new Blob([pdf(n)], { type: "application/pdf" }), `statement-${n}.pdf`);
		await answer("upload", new Request(`${BASE}/api/statements/upload`, { method: "POST", body: f, headers: { Cookie: cookie } }));
	}
	const work = raw.raw.prepare("SELECT gmail_id FROM work WHERE source = 'owner_upload' ORDER BY gmail_id").all() as { gmail_id: string }[];
	const set = raw.raw.prepare("UPDATE work SET stage = ?, error = ? WHERE gmail_id = ?");
	set.run("waiting", "pick account", work[0]!.gmail_id);
	set.run("waiting", "pdf password", work[1]!.gmail_id);
	set.run("failed", "the PDF holds no text", work[2]!.gmail_id);
	await answer("share (not a pdf)", new Request(`${BASE}/api/statements/share`, { method: "POST", body: new Uint8Array([1, 2, 3]), headers: { Authorization: `Bearer ${TAP_KEY}`, "Content-Type": "application/pdf" } }));
	// Alarms, written the way the tick writes them.
	const alarm = raw.raw.prepare("INSERT INTO alarms (key, message, raised_at) VALUES (?, ?, ?)");
	alarm.run("pdf_password:TAISHIN", lockedMessage("taishin", [{ gmail_id: "g1", institution: "taishin", arrived: "2026-09-03", file: null, account_id: "card-t", reason: "wrong_password" }, { gmail_id: "g2", institution: "taishin", arrived: "2026-08-03", file: "Statement Aug.pdf", account_id: null, reason: "no_password" }], { secret: "LEDGER_PDF_PW_TAISHIN", older_secret: "LEDGER_PDF_PW_CARD_T_2" }, () => ACCOUNT), AT);
	alarm.run("alerts_silent:HSBC", silenceMessage("hsbc", 4, "HSBC"), AT);
	alarm.run("google_signin", googleSigninMessage(), AT);
});
afterAll(() => {
	setLanguage("zh-Hant");
	raw.close();
});

describe("an owner who chose English reads no Chinese the ledger wrote", () => {
	it.each([
		"/api/overview?month=2026-10",
		"/api/overview?month=2026-10&group_by=merchant",
		"/api/lines?from=2026-10-01&to=2026-10-31&limit=200",
		"/api/months",
		"/api/trips",
		"/api/subscriptions",
		"/api/needs-ok",
		"/api/accounts",
		"/api/wallets",
		"/api/reimbursable-ranges",
		"/api/status",
		"/api/categories",
		"/api/payments",
		"/api/statements/uploads",
		"/words.js",
		"/",
	])("%s", async (path) => {
		const res = await send(get(path, cookie));
		expect(res.status).toBe(200);
		const text = await res.text();
		const body = res.headers.get("Content-Type")?.includes("json") ? JSON.parse(text) : text;
		expect(chinese(body)).toEqual([]);
		if (path === "/api/needs-ok") {
			// The sweep looked at real questions: every kind the world above raised is there.
			for (const k of ["lines", "held_taps", "pdf_passwords", "uploads", "wallet_topups", "wallet_sms"]) expect((body as Record<string, unknown[]>)[k]?.length, k).toBeGreaterThan(0);
		}
	});

	it("the replies to the page and the Shortcuts, and the alarms", async () => {
		expect(replies.length).toBeGreaterThan(8);
		for (const r of replies) expect([r.what, chinese(r.body)]).toEqual([r.what, []]);
		const alarms = raw.raw.prepare("SELECT key, message FROM alarms").all() as { key: string; message: string }[];
		expect(alarms.length).toBe(3);
		for (const a of alarms) expect([a.key, chinese(a.message)]).toEqual([a.key, []]);
		// and the Chinese data is still there, untranslated, where it belongs
		const needs = JSON.stringify(await (await send(get("/api/needs-ok", cookie))).json());
		expect(needs).toContain(MERCHANT);
	});

	it("the answers on a page action, in English", async () => {
		const body = (await answer("review", post("/api/lines/zh-data/review", { action: "accept" }, cookie))) as { message: string };
		expect(body.message).toBe("Done — this one is fine.");
		expect(chinese(body)).toEqual([]);
	});

	it("the connector: its instructions and every reading tool's answer", async () => {
		const ownerCtx: Ctx = { waitUntil() {}, props: { email: OWNER } };
		let id = 1;
		const rpc = async (method: string, params: unknown) => {
			const res = await handleMcp(new Request(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) }), env(), ownerCtx, deps);
			return (await res.json()) as { result: Record<string, unknown> };
		};
		const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
		expect(chinese(init.result)).toEqual([]);
		const tools = await rpc("tools/list", {});
		expect(chinese(tools.result)).toEqual([]);
		for (const [name, args] of [
			["ledger_query", { from: "2026-10-01", to: "2026-10-31" }],
			["ledger_bills", {}],
			["ledger_categories", {}],
			["ledger_subscriptions", {}],
		] as const) {
			const r = await rpc("tools/call", { name, arguments: args });
			const content = (r.result.content as { text: string }[])[0]!.text;
			expect([name, chinese(JSON.parse(content))]).toEqual([name, []]);
		}
	});
});
