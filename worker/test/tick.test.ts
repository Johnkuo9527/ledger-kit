/// The one-minute tick's frame: the lock, the budget,
/// the close. The engine's own steps are tested in their own files.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { engineStatus } from "../src/alarms";
import { ENGINE_STEPS } from "../src/steps";
import { runTick, type Step } from "../src/tick";
import { exactCountingDb as countingDb, makeDeps, makeEnv } from "./helpers/harness";

let db: TestDb;
beforeEach(() => {
	db = freshDb();
});
afterEach(() => db.close());

const busy = (n: number): Step => ({
	name: "busy",
	async run(t) {
		for (let i = 0; i < n; i++) {
			if (!t.room(1)) return;
			await t.db.prepare("SELECT 1").bind().first();
			t.count("selects");
		}
	},
});

describe("the tick", () => {
	it("an idle tick takes the lock, reads the state and leaves no run row", async () => {
		const c = countingDb(db);
		const r = await runTick(makeEnv(c.db), makeDeps(), {}, []);
		expect(r.ran).toBe(true);
		expect(c.queries()).toBeLessThanOrEqual(4); // lock + state + alarms + release
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
		const status = await engineStatus(db);
		expect(status.last_tick_at).toBe("2026-10-09T02:00:00.000Z");
	});

	it("a second tick while the lock is held leaves after one query; a lapsed lease is taken over", async () => {
		const deps = makeDeps();
		let inner: Promise<unknown> | null = null;
		const c = countingDb(db);
		const reenter: Step = {
			name: "reenter",
			async run() {
				c.reset();
				inner = runTick(makeEnv(c.db), deps, {}, []);
				const r = (await inner) as { ran: boolean };
				expect(r.ran).toBe(false);
				expect(c.queries()).toBe(1);
			},
		};
		await runTick(makeEnv(db), deps, {}, [reenter]);
		expect(inner).not.toBeNull();
		// a tick that died holding the lock: 16 minutes later the next one runs
		db.raw.prepare("UPDATE sync_state SET value = json_set(value, '$.until', '2026-10-09T02:10:00.000Z') WHERE key = 'run_lock'").run();
		deps.advance(16 * 60_000);
		expect((await runTick(makeEnv(db), deps, {}, [])).ran).toBe(true);
	});

	it("never passes the budget, logs the run, and stops cleanly when the budget runs out", async () => {
		const c = countingDb(db);
		const r = await runTick(makeEnv(c.db, { LEDGER_TICK_D1_BUDGET: "60" }), makeDeps(), {}, [busy(1000)]);
		expect(c.queries()).toBeLessThanOrEqual(60);
		expect(r.counts.selects).toBeGreaterThan(40);
		const run = db.raw.prepare("SELECT kind, ok, counts_json FROM runs").get() as { kind: string; ok: number; counts_json: string };
		expect(run.ok).toBe(1);
		expect(JSON.parse(run.counts_json).d1_queries).toBe(c.queries());
	});

	it("a failing step is logged and the next step still runs", async () => {
		const boom: Step = { name: "boom", run: async () => { throw new Error("the feed is down"); } };
		const r = await runTick(makeEnv(db), makeDeps(), {}, [boom, busy(3)]);
		expect(r.counts.selects).toBe(3);
		const run = db.raw.prepare("SELECT ok, error FROM runs").get() as { ok: number; error: string };
		expect(run).toEqual({ ok: 0, error: "boom: the feed is down" });
	});

	it("alarms raised and cleared during the tick land in the close, and are not re-written when unchanged", async () => {
		const deps = makeDeps();
		const raise: Step = { name: "raise", run: async (t) => (t.raise("credit_low", "low"), t.count("x")) };
		await runTick(makeEnv(db), deps, {}, [raise]);
		expect((await engineStatus(db)).alarms.map((a) => a.key)).toEqual(["credit_low"]);
		const c = countingDb(db);
		await runTick(makeEnv(c.db), deps, {}, [raise]);
		expect(c.queries()).toBe(5); // lock, state, alarms, release, run row — no alarm rewrite
		const clear: Step = { name: "clear", run: async (t) => t.clear("credit_low") };
		await runTick(makeEnv(db), deps, {}, [clear]);
		expect((await engineStatus(db)).alarms).toEqual([]);
	});

	it("a close that is refused still releases the lock", async () => {
		const deps = makeDeps();
		db.raw.prepare("INSERT INTO runs (id, kind, started_at) VALUES ('w-0002', 'x', 'x')").run(); // the run id this tick will pick
		await runTick(makeEnv(db), deps, {}, [busy(1)]);
		expect((await runTick(makeEnv(db), deps, {}, [])).ran).toBe(true);
	});

	it("the whole engine, not yet set up (no Gmail, no Claude, no feeds reachable), ticks quietly and cheaply", async () => {
		const c = countingDb(db);
		const deps = makeDeps();
		deps.fetch = (async () => new Response("no", { status: 503 })) as typeof fetch;
		const r = await runTick(makeEnv(c.db), deps, {}, ENGINE_STEPS);
		expect(r.errors).toEqual([]);
		expect(c.queries()).toBeLessThanOrEqual(31); // includes the home currency recorded once (src/home.ts), the day's upkeep, the one-time look back (v3: card days + reread; v5: the one-bill resplit, 2), the one-time card counters (2) and the hourly wallet tidy (2)
		deps.advance(60_000);
		c.reset();
		const again = await runTick(makeEnv(c.db), deps, {}, ENGINE_STEPS);
		expect(again.errors).toEqual([]);
		expect(c.queries()).toBeLessThanOrEqual(8); // the idle tick the owner pays for every minute
	});

	it("stops starting work after eight minutes of wall clock", async () => {
		const deps = makeDeps();
		const slow: Step = { name: "slow", run: async (t) => (deps.advance(9 * 60_000), t.count("slow")) };
		const r = await runTick(makeEnv(db), deps, {}, [slow, busy(3)]);
		expect(r.counts).toEqual({ slow: 1 });
	});
});

describe("the deployed worker", () => {
	it("still serves pages through the OAuth wrapper, and has the scheduled handler", async () => {
		const mod = await import("../src/index");
		const w = mod.default as { fetch(r: Request, e: unknown, c: unknown): Promise<Response>; scheduled: unknown };
		expect(typeof w.scheduled).toBe("function");
		const db = freshDb();
		const res = await w.fetch(new Request("https://ledger.test.workers.dev/"), makeEnv(db), { waitUntil() {}, passThroughOnException() {} });
		expect(res.status).toBeLessThan(500);
		db.close();
	});

	it("the wall-clock setting is read from the var, within sane bounds", async () => {
		const { wallClockMs } = await import("../src/tick");
		expect(wallClockMs(undefined)).toBe(480_000);
		expect(wallClockMs("25")).toBe(25_000);
		expect(wallClockMs("5")).toBe(480_000);
	});
});
