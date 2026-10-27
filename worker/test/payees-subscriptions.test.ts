/// Round 2: the owner's payee rules on the page and the connector (POST
/// /api/lines/:id/kind, /category with apply_to_merchant, ledger_set_kind),
/// and subscriptions by his word (meeting point B: active / lapsed /
/// cancelled / ignored, and marking a line). All through the session and the
/// envelope. MADE-UP names, accounts and amounts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { line } from "../../test/helpers/fixtures";
import { addAccounts, put, subscriptionRow } from "../../test/helpers/world";
import { handleRequest, type App } from "../src/app";
import type { LedgerEnv } from "../src/env";
import { makeOp, setKindOp, subscriptionsOp } from "../src/ops";
import { runTick } from "../src/tick";
import { LOOK_BACK_VERSION, lookBack, upkeep, type LookBackState } from "../src/upkeep";
import { MODELS } from "./helpers/fake-claude";
import { CTX, get, json, makeDeps, makeEnv, post, signedIn, TEST_ASSETS, withLikeCap } from "./helpers/harness";

const CATS = "Food, Rent, Family Support, Others";
let raw: TestDb;
let env: LedgerEnv;
let app: App & { deps: ReturnType<typeof makeDeps> };
let cookie: string;

beforeEach(async () => {
	raw = freshDb();
	await addAccounts(raw);
	raw.raw.prepare("DELETE FROM payee_rules").run(); // made-up rules only
	env = makeEnv(withLikeCap(raw), { LEDGER_CATEGORIES: CATS });
	app = { assets: TEST_ASSETS, deps: makeDeps() };
	cookie = await signedIn();
});
afterEach(() => raw.close());

const send = (r: Request) => handleRequest(r, env, CTX, app);
const kindOf = (id: string) => (raw.raw.prepare("SELECT kind FROM lines WHERE id = ?").get(id) as { kind: string }).kind;
const out = (id: string, merchant_key: string, minor: number, txn_date = "2026-10-03") =>
	put(raw, "lines", line({ id, account_id: "bank-x", kind: "purchase", merchant_key, merchant_name: merchant_key, merchant_raw: merchant_key, txn_date, orig_minor: minor, bill_minor: minor, home_minor: minor }));

describe("「這筆不算花費」: POST /api/lines/:id/kind", () => {
	it("for the payee: every line before — and the next one — never spending; the month totals it apart", async () => {
		await out("m1", "ACME BROKER CLIENTS", 150_000, "2026-10-02");
		await out("m2", "ACME BROKER CLIENTS", 50_000, "2026-10-05");
		await out("f1", "BAKERY", 1_000);
		const b = await json(await send(post("/api/lines/m1/kind", { kind: "investment", apply_to_merchant: true }, cookie)));
		expect(b).toMatchObject({ ok: true, scope: "merchant", changed: 2, line: { id: "m1", kind: "investment", spending: false } });
		expect(kindOf("m2")).toBe("investment");
		const o = await json(await send(get("/api/overview?month=2026-10", cookie)));
		expect(o.totals).toMatchObject({ spending_home: { minor: 1_000 } });
		expect((o.non_spending as { kind: string; total_home: { minor: number }; count: number }[])[0]).toMatchObject({ kind: "investment", total_home: { minor: 200_000 }, count: 2 });
		const lines = await json(await send(get("/api/lines?kind=investment&from=2026-10-01&to=2026-10-31", cookie)));
		expect((lines.lines as { id: string }[]).map((l) => l.id).sort()).toEqual(["m1", "m2"]);
	});

	it("this line only; spending again; refused in plain words for a kind he cannot set", async () => {
		await out("t1", "JANE ROE", 7_000);
		await out("t2", "JANE ROE", 8_000);
		expect(await json(await send(post("/api/lines/t1/kind", { kind: "friend_transfer", apply_to_merchant: false }, cookie)))).toMatchObject({ ok: true, scope: "line", changed: 1 });
		expect([kindOf("t1"), kindOf("t2")]).toEqual(["friend_transfer", "purchase"]);
		expect(await json(await send(post("/api/lines/t1/kind", { kind: "purchase" }, cookie)))).toMatchObject({ ok: true, changed: 1, line: { kind: "purchase", spending: true } });
		const bad = await send(post("/api/lines/t1/kind", { kind: "fee" }, cookie));
		expect(bad.status).toBe(400);
		expect(((await json(bad)).message as string)).toMatch(/investment, loan_repayment, friend_transfer/);
		expect((await send(post("/api/lines/t1/kind", { kind: "investment" }))).status).toBe(401); // no session, no change
		expect(kindOf("t1")).toBe("purchase");
	});
});

describe("「改分類」 with apply_to_merchant: POST /api/lines/:id/category", () => {
	it("true: the payee's lines move at once; false: this line alone", async () => {
		await out("r1", "JANE ROE", 200_000);
		await out("r2", "JANE ROE", 200_000, "2026-09-03");
		const all = await json(await send(post("/api/lines/r1/category", { category: "Rent", apply_to_merchant: true }, cookie)));
		expect(all).toMatchObject({ ok: true, scope: "merchant", changed: 2, others: 0, line: { category: "Rent" } });
		const one = await json(await send(post("/api/lines/r2/category", { category: "Family Support", apply_to_merchant: false }, cookie)));
		expect(one).toMatchObject({ ok: true, scope: "line", changed: 1, line: { category: "Family Support" } });
		expect(raw.raw.prepare("SELECT id, category FROM lines ORDER BY id").all()).toEqual([{ id: "r1", category: "Rent" }, { id: "r2", category: "Family Support" }]);
	});
});

describe("the connector's ledger_set_kind", () => {
	it("by part of a payee's name: the owner's rule for each match; by line_id: one line; with neither: the kinds", async () => {
		await out("c1", "DBS PERSONAL LOAN", 85_000);
		await out("c2", "TAN AH KOW", 1_000);
		const op = await makeOp(env, makeDeps(), "owner");
		const r = await setKindOp(op, { merchant: "personal loan", kind: "loan_repayment" });
		expect(r.changed).toEqual([{ merchant_key: "DBS PERSONAL LOAN", name: "DBS PERSONAL LOAN", kind: "loan_repayment", lines: 1 }]);
		expect(raw.raw.prepare("SELECT merchant_key, kind, set_by FROM payee_rules").all()).toEqual([{ merchant_key: "DBS PERSONAL LOAN", kind: "loan_repayment", set_by: "owner" }]);
		expect((await setKindOp(op, { line_id: "c2", kind: "own_transfer" })).line).toMatchObject({ kind: "transfer" });
		expect((await setKindOp(op, {})).kinds).toContain("friend_transfer");
		await expect(setKindOp(op, { merchant: "nobody", kind: "investment" })).rejects.toThrow(/no merchant/);
	});
});

describe("subscriptions by the owner's word (meeting point B)", () => {
	const subs = async () => (await json(await send(get("/api/subscriptions", cookie)))).subscriptions as { id: string; merchant: string; status: string; status_by: string; marked_by: string | null; occurrences: number }[];

	it("'active' = still running: 訂閱中 whatever detection says, until he says otherwise", async () => {
		await put(raw, "subscriptions", subscriptionRow({ id: "s1", merchant_key: "STREAMCO", merchant_name: "Streamco", status: "lapsed" }));
		const b = await json(await send(post("/api/subscriptions/s1", { action: "active" }, cookie)));
		expect((b.subscriptions as { status: string; status_by: string }[])[0]).toMatchObject({ status: "active", status_by: "owner" });
		const r = await json(await send(post("/api/subscriptions/s1", { action: "restore" }, cookie)));
		expect((r.subscriptions as { status: string; status_by: string }[])[0]).toMatchObject({ status: "lapsed", status_by: "detection" });
		const op = await makeOp(env, makeDeps(), "owner");
		expect((await subscriptionsOp(op, { subscription_id: "streamco", action: "active" })).subscriptions[0]).toMatchObject({ status: "active" });
	});

	it("a line marked as a subscription takes all its merchant's charges; 不是訂閱 sets the merchant aside for good", async () => {
		await put(raw, "lines", line({ id: "g1", merchant_key: "CLIMBING GYM", merchant_name: "Climbing Gym", txn_date: "2026-08-20", orig_minor: 9_000, bill_minor: 9_000, home_minor: 9_000 }));
		await put(raw, "lines", line({ id: "g2", merchant_key: "CLIMBING GYM", merchant_name: "Climbing Gym", txn_date: "2026-09-22", orig_minor: 9_500, bill_minor: 9_500, home_minor: 9_500 }));
		const yes = await json(await send(post("/api/lines/g2/subscription", { value: true, cadence: "monthly" }, cookie)));
		expect(yes).toMatchObject({ ok: true, subscription: { merchant: "Climbing Gym", cadence: "monthly", status: "active", status_by: "owner", marked_by: "owner", occurrences: 2 }, line: { subscription: { cadence: "monthly", status: "active" } } });
		// A new charge: the upkeep keeps his row current, and adds no other cadence for it.
		await put(raw, "lines", line({ id: "g3", merchant_key: "CLIMBING GYM", merchant_name: "Climbing Gym", txn_date: "2026-10-05", orig_minor: 9_500, bill_minor: 9_500, home_minor: 9_500 }));
		const D = makeDeps("2026-10-09T05:00:00.000Z");
		await runTick(makeEnv(raw, MODELS), D, {}, [upkeep]);
		expect(await subs()).toMatchObject([{ merchant: "Climbing Gym", status: "active", marked_by: "owner", occurrences: 3 }]);

		const no = await json(await send(post("/api/lines/g3/subscription", { value: false }, cookie)));
		expect(no).toMatchObject({ ok: true, subscription: { status: "ignored" }, line: { subscription: { status: "ignored" } } });
		D.advance(86_400_000);
		await runTick(makeEnv(raw, MODELS), D, {}, [upkeep]);
		expect((await subs()).map((s) => s.status)).toEqual(["ignored"]);
		expect((await send(post("/api/lines/g3/subscription", {}, cookie))).status).toBe(400);
	});

	it("an ignored merchant is never proposed again, at any cadence", async () => {
		for (const [i, d] of ["2026-07-03", "2026-08-03", "2026-09-03", "2026-10-03"].entries()) {
			await put(raw, "lines", line({ id: `p${i}`, txn_date: d, merchant_key: "PARKING", merchant_name: "Parking", orig_minor: 500, bill_minor: 500, home_minor: 500 }));
		}
		await put(raw, "subscriptions", { ...subscriptionRow({ id: "old", merchant_key: "PARKING", merchant_name: "Parking", cadence: "quarterly" }), owner_status: "ignored" });
		await runTick(makeEnv(raw, MODELS), makeDeps("2026-10-09T05:00:00.000Z"), {}, [upkeep]);
		expect(raw.raw.prepare("SELECT id, cadence, owner_status FROM subscriptions").all()).toEqual([{ id: "old", cadence: "quarterly", owner_status: "ignored" }]);
	});
});

describe("the look back, version 2", () => {
	it("a ledger that finished version 1 only reads its lines under the owner's payee rules", async () => {
		raw.raw.prepare("INSERT INTO payee_rules (merchant_key, kind, category, set_by, updated_at) VALUES ('JANE ROE', 'purchase', 'Rent', 'owner', '2026-10-01T00:00:00.000Z')").run();
		await out("j1", "JAXX ROE", 200_000);
		raw.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('look_back', ?, '2026-10-01T00:00:00.000Z')").run(JSON.stringify({ version: 1, piece: "done", cursor: null, changed: 7 }));
		const r = await runTick(makeEnv(raw, MODELS), makeDeps("2026-10-09T05:00:00.000Z"), {}, [lookBack]);
		expect(r.counts.look_back_changed).toBe(1);
		const state = JSON.parse((raw.raw.prepare("SELECT value FROM sync_state WHERE key = 'look_back'").get() as { value: string }).value) as LookBackState;
		expect(state).toMatchObject({ version: LOOK_BACK_VERSION, piece: "done", changed: 8 });
		expect(raw.raw.prepare("SELECT category FROM lines WHERE id = 'j1'").get()).toEqual({ category: "Rent" });
	});
});
