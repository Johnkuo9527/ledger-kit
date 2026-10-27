/// POST /api/shortcut/tap — the Apple Pay shortcut (CONTRACT.md §6.6), through
/// the worker's front door. Made-up cards, merchants and amounts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { ingestEvidence } from "../../src/engine";
import { testEngine } from "../../test/helpers/world";
import { handleRequest, type App } from "../src/app";
import type { LedgerEnv } from "../src/env";
import { CTX, json, makeDeps, makeEnv, post, seedWorld, signedIn, TAP_KEY, TEST_ASSETS, UNLOCK_KEY } from "./helpers/harness";

let db: TestDb;
let env: LedgerEnv;
let app: App;
beforeEach(async () => {
	db = freshDb();
	await seedWorld(db);
	env = makeEnv(db);
	app = { assets: TEST_ASSETS, deps: makeDeps() };
});
afterEach(() => db.close());

const send = (r: Request, e: LedgerEnv = env) => handleRequest(r, e, CTX, app);
const auth = (key = TAP_KEY) => ({ Authorization: `Bearer ${key}` });
const TAP = { card: "Test Rewards", merchant: "Noodle Bar", amount: "S$7.80", timestamp: "2026-10-08T12:30:00+08:00" };
const count = async (sql: string) => ((await db.prepare(sql).bind().first<{ n: number }>())!.n);

describe("the shortcut's key", () => {
	it("no key, a wrong key, the page's unlock key or the page's cookie: 401 'not authorised', nothing written", async () => {
		const before = await count("SELECT COUNT(*) AS n FROM evidence");
		for (const headers of [{}, auth("wrong"), auth(TAP_KEY + "x"), auth(UNLOCK_KEY), { Authorization: TAP_KEY }]) {
			const res = await send(post("/api/shortcut/tap", TAP, undefined, headers));
			expect(res.status).toBe(401);
			expect(await json(res)).toEqual({ ok: false, message: "not authorised" });
		}
		const withCookie = await send(post("/api/shortcut/tap", TAP, await signedIn()));
		expect(withCookie.status).toBe(401);
		expect(await count("SELECT COUNT(*) AS n FROM evidence")).toBe(before);
	});

	it("a worker whose shortcut key is unset or short refuses every tap", async () => {
		for (const over of [{ LEDGER_SHORTCUT_KEY: undefined }, { LEDGER_SHORTCUT_KEY: "short-key" }]) {
			expect((await send(post("/api/shortcut/tap", TAP, undefined, auth("short-key")), makeEnv(db, over))).status).toBe(401);
		}
	});

	it("is checked before the body is even read: a stranger's bad body is still just 401", async () => {
		expect((await send(post("/api/shortcut/tap", "{garbage", undefined, auth("wrong")))).status).toBe(401);
	});

	it("only POST", async () => {
		const res = await send(new Request("https://ledger.test.workers.dev/api/shortcut/tap", { headers: auth() }));
		expect(res.status).toBe(405);
		expect((await json(res)).ok).toBe(false);
	});
});

describe("a tap", () => {
	it("creates a provisional line on the card its Wallet name belongs to, and says so in a sentence", async () => {
		const res = await send(post("/api/shortcut/tap", TAP, undefined, auth()));
		expect(res.status).toBe(200);
		const b = await json(res);
		expect(b).toMatchObject({ ok: true, status: "created", message: "已記下：Noodle Bar SGD 7.80（card-a）" }); // the owner's language (the tests' zh-Hant); English in english.test.ts
		const line = await db.prepare("SELECT account_id, txn_date, bill_minor, state, created_by FROM lines WHERE id = ?").bind(b.line_id).first();
		expect(line).toEqual({ account_id: "card-a", txn_date: "2026-10-08", bill_minor: 780, state: "open", created_by: "rules" });
	});

	it("sent twice (the shortcut ran twice) is one purchase", async () => {
		await send(post("/api/shortcut/tap", TAP, undefined, auth()));
		const again = await json(await send(post("/api/shortcut/tap", TAP, undefined, auth())));
		expect(again).toEqual({ ok: true, status: "duplicate", line_id: null, message: "已經記過了" });
		expect(await count("SELECT COUNT(*) AS n FROM lines WHERE merchant_raw = 'Noodle Bar'")).toBe(1);
	});

	it("joins the bank alert already there for the same purchase (one purchase = one line)", async () => {
		// Fresh ids: the seeded world's engine already used the test engine's id-0001… sequence.
		const alert = await ingestEvidence({ ...testEngine(db), newId: () => crypto.randomUUID() }, {
			type: "alert",
			institution: "hsbc",
			last4: "1111",
			fingerprint: "alert|made-up|noodle",
			txn_date: "2026-10-08",
			currency: "SGD",
			amount_minor: 780,
			merchant_raw: "NOODLE BAR SINGAPORE",
			kind_hint: "purchase",
		});
		expect(alert.status).toBe("created");
		const b = await json(await send(post("/api/shortcut/tap", TAP, undefined, auth())));
		expect(b).toMatchObject({ ok: true, status: "attached", line_id: (alert as { line_id: string }).line_id });
		expect(String(b.message)).toContain("帳本已經有這筆");
		expect(await count("SELECT COUNT(*) AS n FROM lines WHERE txn_date = '2026-10-08'")).toBe(1);
	});

	it("from a Wallet card the ledger does not know is held — never guessed onto a card — and escalated", async () => {
		const b = await json(await send(post("/api/shortcut/tap", { ...TAP, card: "Brand New Card" }, undefined, auth())));
		expect(b).toMatchObject({ ok: true, status: "held", line_id: null });
		expect(String(b.message)).toContain("請到帳本頁的「待確認」選是哪張卡");
		expect(await count("SELECT COUNT(*) AS n FROM lines WHERE merchant_raw = 'Noodle Bar'")).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM escalations WHERE kind = 'unknown_wallet_card' AND status = 'open'")).toBe(2); // this one and the seeded Mystery Card
	});

	it("that cannot be read is a 400 saying which field", async () => {
		const cases: [unknown, RegExp][] = [
			[{ ...TAP, card: "" }, /card is missing/],
			[{ ...TAP, amount: "$4.50", currency: "dollars" }, /currency/],
			[{ ...TAP, amount: "4,50 kr" }, /several currencies/], // a krona sign at a Singapore home: which one?
			[{ ...TAP, timestamp: "2026-10-08 12:30" }, /time zone/],
			[{ ...TAP, amount: "S$0.00" }, /more than zero/],
		];
		for (const [body, why] of cases) {
			const res = await send(post("/api/shortcut/tap", body, undefined, auth()));
			expect(res.status).toBe(400);
			const b = await json(res);
			expect(b.ok).toBe(false);
			expect(String(b.message)).toMatch(why);
		}
		for (const raw of ["{not json", "[]", "x".repeat(9000)]) {
			const res = await send(post("/api/shortcut/tap", raw, undefined, auth()));
			expect(res.status).toBe(400);
			expect((await json(res)).ok).toBe(false);
		}
	});
});
