/// The owner's two FX rules, with every expected figure worked by hand first.

import { describe, expect, it } from "vitest";
import { estimateBill, markupFor, marketRate, observe, homeView, shouldLearn, type RateLookup } from "../src/fx";

// Made-up reference rates, stored as X→SGD like the real table will be.
const RATES: Record<string, number> = {
	"2026-03-10|USD|SGD": 1.35,
	"2026-03-10|JPY|SGD": 0.009,
	"2026-03-10|TWD|SGD": 0.042,
	"2026-03-13|USD|SGD": 1.34, // a Friday; nothing published on the weekend
};
const lookup: RateLookup = (d, c, q) => RATES[`${d}|${c}|${q}`];
const DEFAULTS = new Map([
	["hsbc", 0.0325],
	["taishin", 0.015],
	["*", 0.03],
]);

describe("the market rate", () => {
	it("is 1 within one currency", () => {
		expect(marketRate(lookup, "2026-03-10", "SGD", "SGD")).toEqual({ rate: 1, rate_date: "2026-03-10" });
	});

	it("reads direct, inverse and crossed through SGD", () => {
		expect(marketRate(lookup, "2026-03-10", "USD", "SGD")?.rate).toBe(1.35);
		expect(marketRate(lookup, "2026-03-10", "SGD", "USD")?.rate).toBeCloseTo(1 / 1.35, 12);
		// USD→TWD = 1.35 ÷ 0.042 = 32.142857…
		expect(marketRate(lookup, "2026-03-10", "USD", "TWD")?.rate).toBeCloseTo(32.142857142857, 9);
	});

	it("borrows the last published day over a weekend, but not for ever", () => {
		expect(marketRate(lookup, "2026-03-15", "USD", "SGD")).toEqual({ rate: 1.34, rate_date: "2026-03-13" });
		expect(marketRate(lookup, "2026-03-21", "USD", "SGD")).toBeNull(); // 8 days after the last rate
	});
});

describe("the markup an estimate uses", () => {
	it("prefers the card's own learned markup", () => {
		expect(markupFor({ markup: 0.0287, observed_txn_date: "2026-02-01" }, "hsbc", DEFAULTS)).toEqual({ markup: 0.0287, source: "learned" });
	});

	it("falls back to the bank's default, marked as such", () => {
		expect(markupFor(undefined, "hsbc", DEFAULTS)).toEqual({ markup: 0.0325, source: "bank_default" });
		expect(markupFor(undefined, "unknownbank", DEFAULTS)).toEqual({ markup: 0.03, source: "bank_default" });
		expect(() => markupFor(undefined, "x", new Map())).toThrow();
	});
});

describe("estimate → confirmed", () => {
	it("estimates foreign × market rate × (1 + markup)", () => {
		// USD 100.00 × 1.35 × 1.0325 = SGD 139.3875 → 13938.75 cents → 13939
		expect(estimateBill(10000, "USD", "SGD", 1.35, 0.0325)).toBe(13939);
		// JPY 5,000 × 0.009 × 1.0325 = SGD 46.4625 → 4646
		expect(estimateBill(5000, "JPY", "SGD", 0.009, 0.0325)).toBe(4646);
		// A 台新 card charged USD 20.00: 20 × 32.142857 × 1.015 = TWD 652.50 → 65250
		expect(estimateBill(2000, "USD", "TWD", 1.35 / 0.042, 0.015)).toBe(65250);
	});

	it("measures the real rate and markup from the billed amount", () => {
		// Billed SGD 139.50 for USD 100.00: effective 1.395; 1.395 ÷ 1.35 − 1 = 0.033333…
		const o = observe(13950, 10000, "USD", "SGD", 1.35);
		expect(o.effective_rate).toBeCloseTo(1.395, 12);
		expect(o.observed_markup).toBeCloseTo(0.0333333333, 9);
		expect(() => observe(100, 0, "USD", "SGD", 1.35)).toThrow();
	});

	it("learns only from purchases, plausible markups, and the newest observation", () => {
		const current = { markup: 0.03, observed_txn_date: "2026-03-01" };
		expect(shouldLearn("purchase", 10000, 0.0333, "2026-03-10", current)).toBe(true);
		expect(shouldLearn("purchase", 10000, 0.0333, "2026-03-01", current)).toBe(true); // same day: later confirmation wins
		expect(shouldLearn("purchase", 10000, 0.0333, "2026-02-01", current)).toBe(false); // backfill arriving late
		expect(shouldLearn("refund", -10000, 0, "2026-03-10", current)).toBe(false);
		expect(shouldLearn("purchase", 10000, 0.2, "2026-03-10", current)).toBe(false); // a mis-match, not a markup
		expect(shouldLearn("purchase", 10000, -0.06, "2026-03-10", current)).toBe(false);
		expect(shouldLearn("purchase", 10000, 0.0333, "2026-01-01", undefined)).toBe(true);
	});
});

describe("the SGD figure", () => {
	it("passes an SGD account's amount and status straight through", () => {
		expect(homeView(13939, "SGD", "estimate", null)).toEqual({ home_minor: 13939, home_status: "estimate", home_rate: null });
		expect(homeView(13950, "SGD", "confirmed", null)).toEqual({ home_minor: 13950, home_status: "confirmed", home_rate: null });
	});

	it("converts a TWD account at the reference rate and calls it that", () => {
		// TWD 1,000.00 × 0.042 = SGD 42.00
		expect(homeView(100000, "TWD", "exact", 0.042)).toEqual({ home_minor: 4200, home_status: "reference", home_rate: 0.042 });
		// Even a confirmed TWD bill is only a reference figure in SGD.
		expect(homeView(100000, "TWD", "confirmed", 0.042).home_status).toBe("reference");
		expect(homeView(100000, "TWD", "exact", null)).toEqual({ home_minor: 0, home_status: "reference", home_rate: null });
	});
});
