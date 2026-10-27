/// Exchange rates are kept against the owner's HOME currency (src/home.ts), not
/// a fixed one. Every feed here is made up; every expected rate is worked by hand.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { setHome, SINGAPORE } from "../../src/home";
import { fxCurrencies, fxFeed } from "../src/fx-feed";
import { runTick } from "../src/tick";
import { makeDeps, makeEnv } from "./helpers/harness";

let db: TestDb;
beforeEach(() => {
	db = freshDb();
});
afterEach(() => {
	db.close();
	setHome(SINGAPORE);
});

const rows = (quote: string) =>
	db.raw.prepare("SELECT currency, rate, source FROM fx_rates WHERE quote = ? AND date = '2026-10-08' ORDER BY currency").all(quote) as { currency: string; rate: number; source: string }[];

describe("rates against a home currency the ECB publishes (EUR, Berlin)", () => {
	it("asks the ECB with base=EUR, the rest from the euro page of the fallback feed, and stores X → EUR", async () => {
		const calls: string[] = [];
		const deps = makeDeps();
		deps.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			calls.push(url);
			const ecb = /frankfurter\.dev\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\?base=EUR&symbols=(.+)$/.exec(url);
			// 1 EUR = 1.10 USD and 1.50 SGD; the ECB has no TWD.
			if (ecb) return Response.json({ base: "EUR", rates: { "2026-10-08": { USD: 1.1, SGD: 1.5 } } });
			// The fallback's euro page: 1 EUR = 35 TWD.
			const other = /currency-api@(\d{4}-\d{2}-\d{2})\/v1\/currencies\/eur\.json$/.exec(url);
			if (other) return Response.json({ date: other[1], eur: { twd: 35, usd: 1.1 } });
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;
		const env = makeEnv(db, { LEDGER_HOME_CURRENCY: "EUR", LEDGER_TIMEZONE: "Europe/Berlin", LEDGER_HOME_COUNTRY: "DE", LEDGER_FX_CURRENCIES: "USD,SGD,TWD,EUR", LEDGER_BACKFILL_MONTHS: "1" });
		for (let i = 0; i < 3; i++) {
			await runTick(env, deps, {}, [fxFeed]);
			deps.advance(60_000);
		}
		const ecbCall = calls.find((u) => u.includes("frankfurter"))!;
		// The home currency is never asked for against itself.
		// …nor for one the ECB does not publish (TWD comes from the fallback feed only).
		expect(ecbCall).toMatch(/base=EUR&symbols=USD,SGD$/);
		expect(calls.some((u) => u.includes("sgd.json"))).toBe(false);
		// X → EUR: 1 USD = 1/1.10 = 0.9090… EUR; 1 SGD = 1/1.50 = 0.6666… EUR; 1 TWD = 1/35 = 0.02857… EUR.
		const got = rows("EUR");
		expect(got.map((r) => [r.currency, r.source])).toEqual([
			["SGD", "ecb"],
			["TWD", "currency-api"],
			["USD", "ecb"],
		]);
		expect(got.find((r) => r.currency === "USD")!.rate).toBeCloseTo(0.909091, 6);
		expect(got.find((r) => r.currency === "SGD")!.rate).toBeCloseTo(0.666667, 6);
		expect(got.find((r) => r.currency === "TWD")!.rate).toBeCloseTo(0.028571, 6);
		expect(rows("SGD")).toEqual([]);
	});
});

describe("rates against a home currency the ECB does not publish (TWD, Taipei)", () => {
	it("never asks the ECB; every currency comes from the fallback feed's NT$ page", async () => {
		const calls: string[] = [];
		const deps = makeDeps();
		deps.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			calls.push(url);
			// 1 TWD = 0.03125 USD (so 1 USD = 32 TWD) and 4.8 JPY (so 1 JPY = 0.2083… TWD).
			const other = /currency-api@(\d{4}-\d{2}-\d{2})\/v1\/currencies\/twd\.json$/.exec(url);
			if (other) return Response.json({ date: other[1], twd: { usd: 0.03125, jpy: 4.8 } });
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;
		const env = makeEnv(db, { LEDGER_HOME_CURRENCY: "TWD", LEDGER_TIMEZONE: "Asia/Taipei", LEDGER_HOME_COUNTRY: "TW", LEDGER_FX_CURRENCIES: "USD,JPY", LEDGER_BACKFILL_MONTHS: "1" });
		for (let i = 0; i < 4; i++) {
			await runTick(env, deps, {}, [fxFeed]);
			deps.advance(60_000);
		}
		expect(calls.some((u) => u.includes("frankfurter"))).toBe(false);
		const got = rows("TWD");
		expect(got.map((r) => r.currency)).toEqual(["JPY", "USD"]);
		expect(got.find((r) => r.currency === "USD")!.rate).toBe(32);
		expect(got.find((r) => r.currency === "JPY")!.rate).toBeCloseTo(0.208333, 6);
		const st = JSON.parse((db.raw.prepare("SELECT value FROM sync_state WHERE key = 'fx'").get() as { value: string }).value);
		expect(st).toMatchObject({ missing: ["USD", "JPY"], other_through: "2026-10-08" });
	});
});

describe("the currencies that get rates", () => {
	it("follow the home: the home currency is left out, SGD is an ordinary foreign currency", () => {
		setHome({ currency: "GBP", timeZone: "Europe/London", country: "GB" });
		expect(fxCurrencies("usd, GBP, sgd")).toEqual(["USD", "SGD"]);
		expect(fxCurrencies(undefined)).toContain("SGD");
		expect(fxCurrencies(undefined)).not.toContain("GBP");
	});
});
