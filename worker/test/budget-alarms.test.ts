/// The daily engine foundations: the per-tick D1 budget wrapper, the alarms, and the
/// page's /api/status route. Made-up data only; the database is in memory.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { clearAlarm, engineStatus, openAlarms, raiseAlarm } from "../src/alarms";
import { handleRequest } from "../src/app";
import { BudgetDb, BudgetExhausted, DEFAULT_TICK_BUDGET, RESERVE, tickBudget } from "../src/budget";
import { CTX, get, json, makeDeps, makeEnv, signedIn, TEST_ASSETS } from "./helpers/harness";

let db: TestDb;
beforeEach(() => {
	db = freshDb();
});
afterEach(() => db.close());

describe("the tick's D1 budget", () => {
	it("is one setting, 400 unless set, never above Cloudflare's 1,000", () => {
		expect(tickBudget(undefined)).toBe(DEFAULT_TICK_BUDGET);
		expect(DEFAULT_TICK_BUDGET).toBe(400);
		expect(tickBudget("250")).toBe(250);
		expect(tickBudget("5000")).toBe(1000);
		expect(tickBudget("nonsense")).toBe(400);
		expect(tickBudget("10")).toBe(400); // below a usable tick: ignored
	});

	it("counts every query and every statement of a batch, and refuses past the limit minus the reserve", async () => {
		const b = new BudgetDb(db, 10);
		await b.prepare("SELECT 1").bind().first();
		await b.prepare("SELECT 1").bind().all();
		await b.batch([b.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('a', '1', 'x')").bind(), b.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('b', '1', 'x')").bind()]);
		expect(b.used).toBe(4);
		expect(b.remaining()).toBe(10 - RESERVE - 4);
		await expect(b.batch([b.prepare("SELECT 1").bind(), b.prepare("SELECT 1").bind(), b.prepare("SELECT 1").bind()])).rejects.toBeInstanceOf(BudgetExhausted);
		expect(b.used).toBe(4); // a refused batch touches nothing
		b.closing();
		await b.batch([b.prepare("SELECT 1").bind(), b.prepare("SELECT 1").bind(), b.prepare("SELECT 1").bind()]);
		expect(b.used).toBe(7);
		expect(() => b.prepare("SELECT 1").bind().first()).not.toThrow();
		expect(() => b.prepare("SELECT 1").bind().first()).not.toThrow();
		expect(() => b.prepare("SELECT 1").bind().first()).not.toThrow();
		expect(() => b.prepare("SELECT 1").bind().first()).toThrow(BudgetExhausted);
		expect(b.used).toBe(10);
	});

	it("a batch is still all-or-nothing through the wrapper", async () => {
		const b = new BudgetDb(db, 400);
		await expect(
			b.batch([
				b.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('k', '1', 'x')").bind(),
				b.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('k', '2', 'x')").bind(), // duplicate key
			]),
		).rejects.toThrow();
		expect((await db.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE key = 'k'").bind().first<{ n: number }>())!.n).toBe(0);
	});
});

describe("alarms", () => {
	it("raise, refresh, clear and re-open", async () => {
		await raiseAlarm(db, "google_signin", "Google refused the sign-in", "2026-10-09T00:00:00.000Z").run();
		await raiseAlarm(db, "google_signin", "Google refused the sign-in again", "2026-10-09T01:00:00.000Z").run();
		let open = await openAlarms(db);
		expect(open).toHaveLength(1);
		expect(open[0]).toMatchObject({ message: "Google refused the sign-in again", raised_at: "2026-10-09T00:00:00.000Z" });
		await db.prepare("UPDATE alarms SET notified_at = 'n'").bind().run();
		await clearAlarm(db, "google_signin", "2026-10-09T02:00:00.000Z").run();
		expect(await openAlarms(db)).toHaveLength(0);
		await raiseAlarm(db, "google_signin", "again", "2026-10-10T00:00:00.000Z").run();
		open = await openAlarms(db);
		expect(open[0]).toMatchObject({ raised_at: "2026-10-10T00:00:00.000Z", notified_at: null, cleared_at: null });
	});
});

describe("GET /api/status", () => {
	it("answers ok:true with alarms, the last run, the heartbeat and the queue", async () => {
		await raiseAlarm(db, "credit_low", "API credit is under US$5", "2026-10-09T00:00:00.000Z").run();
		await db.prepare("INSERT INTO runs (id, kind, started_at, finished_at, ok, counts_json, error) VALUES ('r1', 'daily', '2026-10-09T01:00:00.000Z', '2026-10-09T01:01:00.000Z', 1, '{}', NULL)").bind().run();
		await db.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('run_lock', ?, 'x'), ('phase', 'daily', 'x')").bind(JSON.stringify({ holder: null, until: null, at: "2026-10-09T01:59:00.000Z" })).run();
		await db.prepare("INSERT INTO work (gmail_id, source, stage, created_at, updated_at) VALUES ('m1', 'daily', 'new', 'x', 'x'), ('m2', 'daily', 'failed', 'x', 'x'), ('m3', 'daily', 'done', 'x', 'x')").bind().run();
		const res = await handleRequest(get("/api/status", await signedIn()), makeEnv(db), CTX, { assets: TEST_ASSETS, deps: makeDeps() });
		const body = await json(res);
		expect(res.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body).toMatchObject({
			alarms: [{ key: "credit_low" }],
			last_run: { kind: "daily", ok: true },
			last_tick_at: "2026-10-09T01:59:00.000Z",
			phase: "daily",
			queue: { waiting: 1, failed: 1 },
		});
	});

	it("an empty engine says so honestly", async () => {
		expect(await engineStatus(db, { today: "2026-10-09" })).toEqual({
			alarms: [],
			last_run: null,
			last_tick_at: null,
			phase: "not_started",
			queue: { waiting: 0, failed: 0 },
			estimate: null,
			older_months: null,
			diagnostic: {
				gmail_checked_at: null,
				gmail_check_running_since: null,
				daily_pull_day: null,
				work: [],
				spend_today: { day: "2026-10-09", daily_usd: 0, daily_cap_usd: 3, mail_reserve_usd: 1, catchup_usd: 0, older_months_usd: 0, backfill_usd: 0 },
				catchup: { approved_usd: 0, spent_usd: 0 },
			},
			reader: { mode: "api", open: { daily: 0, senior: 0 }, claimed: 0, failed: 0, oldest_open_at: null, oldest_open: { daily: null, senior: null }, last_submit_at: null, by_kind: [] },
		});
	});
});
