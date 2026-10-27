/// Daily exchange rates. Every feed is made up here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addDays } from "../../src/dates";
import { fxCurrencies, fxFeed, fxStart } from "../src/fx-feed";
import { runTick } from "../src/tick";
import { exactCountingDb, makeDeps, makeEnv } from "./helpers/harness";

let db: TestDb;
beforeEach(() => {
	db = freshDb();
});
afterEach(() => db.close());

/// A made-up ECB (no TWD, weekdays only) and a made-up currency-api.
function feeds(opts: { ecbDown?: boolean; otherFrom?: string } = {}) {
	const calls: string[] = [];
	const deps = makeDeps();
	deps.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		const ecb = /frankfurter\.dev\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\?base=SGD&symbols=(.+)$/.exec(url);
		if (ecb) {
			if (opts.ecbDown) return new Response("down", { status: 503 });
			const rates: Record<string, Record<string, number>> = {};
			for (let d = ecb[1]!; d <= ecb[2]! && d <= "2026-10-08"; d = addDays(d, 1)) {
				const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
				if (dow === 0 || dow === 6) continue;
				rates[d] = Object.fromEntries(ecb[3]!.split(",").filter((c) => c !== "TWD").map((c) => [c, c === "USD" ? 0.8 : c === "JPY" ? 115 : 1.25]));
			}
			return Response.json({ base: "SGD", rates });
		}
		const other = /currency-api@(\d{4}-\d{2}-\d{2})\/v1\/currencies\/sgd\.json$/.exec(url);
		if (other) {
			if (opts.otherFrom && other[1]! < opts.otherFrom) return new Response("nf", { status: 404 });
			return Response.json({ date: other[1], sgd: { twd: 25, usd: 0.8 } });
		}
		if (/currency-api\.pages\.dev/.test(url)) return new Response("nf", { status: 404 });
		throw new Error(`unexpected fetch ${url}`);
	}) as typeof fetch;
	return { deps, calls };
}

const rate = (date: string, c: string) => (db.raw.prepare("SELECT rate, source FROM fx_rates WHERE date = ? AND currency = ? AND quote = 'SGD'").get(date, c) as { rate: number; source: string } | undefined);

describe("the FX feed", () => {
	it("keeps twelve currencies unless told otherwise, and reaches back the backfill's months plus one", () => {
		expect(fxCurrencies(undefined)).toHaveLength(12);
		expect(fxCurrencies("usd, SGD, eur,b4d")).toEqual(["USD", "EUR"]);
		expect(fxStart("2026-10-09", 24)).toBe("2024-09-01");
	});

	it("fills two years: the ECB in one call, TWD a day at a time (60 a tick), each stored as X → SGD", async () => {
		const { deps, calls } = feeds({ otherFrom: "2024-09-15" });
		const c = exactCountingDb(db);
		const env = makeEnv(c.db, { LEDGER_FX_CURRENCIES: "USD,JPY,TWD" });
		await runTick(env, deps, {}, [fxFeed]);
		expect(calls.filter((u) => u.includes("frankfurter"))).toHaveLength(1);
		expect(rate("2026-10-08", "USD")).toEqual({ rate: 1.25, source: "ecb" });
		expect(rate("2026-10-08", "JPY")!.rate).toBeCloseTo(1 / 115, 10);
		expect(rate("2024-09-02", "USD")).toBeTruthy();
		expect(calls.filter((u) => u.includes("jsdelivr"))).toHaveLength(60);
		expect(c.queries()).toBeLessThan(20);
		for (let i = 0; i < 20; i++) {
			deps.advance(60_000);
			await runTick(env, deps, {}, [fxFeed]);
		}
		expect(rate("2024-09-14", "TWD")).toBeUndefined(); // before the feed began: skipped, not stuck
		expect(rate("2024-09-15", "TWD")).toEqual({ rate: 0.04, source: "currency-api" });
		expect(rate("2026-10-08", "TWD")).toEqual({ rate: 0.04, source: "currency-api" });
		const st = JSON.parse((db.raw.prepare("SELECT value FROM sync_state WHERE key = 'fx'").get() as { value: string }).value);
		expect(st).toMatchObject({ ecb_through: "2026-10-08", other_through: "2026-10-08", missing: ["TWD"] });
		// caught up: no call for six hours, then only the last two days are asked again
		const before = calls.length;
		deps.advance(3_600_000);
		await runTick(env, deps, {}, [fxFeed]);
		expect(calls.length).toBe(before);
		deps.advance(6 * 3_600_000);
		await runTick(env, deps, {}, [fxFeed]);
		expect(calls.slice(before)).toEqual([expect.stringContaining("v1/2026-10-08..2026-10-09"), expect.stringContaining("currency-api@2026-10-09")]);
	});

	it("a feed that is down is tried again later, and nothing breaks", async () => {
		const { deps } = feeds({ ecbDown: true });
		const r = await runTick(makeEnv(db), deps, {}, [fxFeed]);
		expect(r.errors).toEqual([]);
		expect(r.counts.fx_unavailable).toBe(1);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM fx_rates").get()).toEqual({ n: 0 });
	});
});
