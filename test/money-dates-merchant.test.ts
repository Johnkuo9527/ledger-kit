import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, isIsoDate } from "../src/dates";
import { localDate } from "../src/home";
import { merchantKey, merchantSimilarity } from "../src/merchant";
import { convertMinor, exponent, formatMoney, parseMajor, roundHalfAway } from "../src/money";

describe("money is integers", () => {
	it("knows each currency's decimals", () => {
		expect(exponent("SGD")).toBe(2);
		expect(exponent("TWD")).toBe(2);
		expect(exponent("JPY")).toBe(0);
		expect(exponent("KWD")).toBe(3);
	});

	it("rounds half away from zero, through binary noise", () => {
		expect(roundHalfAway(2.5)).toBe(3);
		expect(roundHalfAway(-2.5)).toBe(-3);
		expect(roundHalfAway(1.005 * 100)).toBe(101); // 100.49999999999999 in binary
		expect(roundHalfAway(2.4999)).toBe(2);
		expect(Object.is(roundHalfAway(-0.2), 0)).toBe(true); // never −0
	});

	it("converts between currencies of different decimals", () => {
		// USD 100.00 × 1.35 = SGD 135.00
		expect(convertMinor(10000, "USD", "SGD", 1.35)).toBe(13500);
		// JPY 1,200 × 0.0091 = SGD 10.92
		expect(convertMinor(1200, "JPY", "SGD", 0.0091)).toBe(1092);
		// and back: SGD 10.92 ÷ 0.0091 = JPY 1,200
		expect(convertMinor(1092, "SGD", "JPY", 1 / 0.0091)).toBe(1200);
	});

	it("refuses a float where money belongs", () => {
		expect(() => convertMinor(12.5, "SGD", "USD", 1)).toThrow(TypeError);
		expect(() => formatMoney(0.1, "SGD")).toThrow(TypeError);
	});

	it("parses typed amounts without a float", () => {
		expect(parseMajor("12.50", "SGD")).toBe(1250);
		expect(parseMajor("12.5", "SGD")).toBe(1250);
		expect(parseMajor("1,234", "SGD")).toBe(123400);
		expect(parseMajor("-3", "SGD")).toBe(-300);
		expect(parseMajor("0.1", "SGD")).toBe(10);
		expect(parseMajor("1200", "JPY")).toBe(1200);
		expect(() => parseMajor("12.5", "JPY")).toThrow(); // yen have no cents
		expect(() => parseMajor("12.345", "SGD")).toThrow();
		expect(() => parseMajor("twelve", "SGD")).toThrow();
	});

	it("formats plainly", () => {
		expect(formatMoney(123450, "SGD")).toBe("SGD 1,234.50");
		expect(formatMoney(-300, "SGD")).toBe("−SGD 3.00");
		expect(formatMoney(5, "SGD")).toBe("SGD 0.05");
		expect(formatMoney(1200, "JPY")).toBe("JPY 1,200");
	});
});

describe("dates", () => {
	it("counts days across a month end", () => {
		expect(daysBetween("2026-02-27", "2026-03-01")).toBe(2);
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});

	it("adds months clamped to the month end, returning to the anchor day", () => {
		expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
		expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
		expect(addMonths("2026-02-28", 1, 31)).toBe("2026-03-31");
		expect(addMonths("2026-03-15", -3)).toBe("2025-12-15");
	});

	it("validates calendar dates", () => {
		expect(isIsoDate("2026-02-28")).toBe(true);
		expect(isIsoDate("2026-02-30")).toBe(false);
		expect(isIsoDate("2026-2-3")).toBe(false);
	});

	it("uses the Singapore calendar day", () => {
		// 16:30 UTC on the 8th is 00:30 on the 9th in Singapore.
		expect(localDate(new Date("2026-10-08T16:30:00Z"))).toBe("2026-10-09");
	});
});

describe("merchant names", () => {
	it("strips processor prefixes, references, store numbers and filler", () => {
		expect(merchantKey("SQ *QUEENSTOWN BAKERY")).toBe("QUEENSTOWN BAKERY");
		expect(merchantKey("STARBUCKS COFFEE #1234 SINGAPORE SG")).toBe("STARBUCKS COFFEE");
		expect(merchantKey("AGODA BKG 849302XK")).toBe("AGODA BKG");
	});

	it("folds known aliases", () => {
		expect(merchantKey("GRAB*A-7F3K2 SINGAPORE SG")).toBe("GRAB");
		expect(merchantKey("Grab")).toBe("GRAB");
		expect(merchantKey("GRABFOOD SG")).toBe("GRAB FOOD");
		expect(merchantKey("APPLE.COM/BILL 866-712-7753 IE")).toBe("APPLE");
		expect(merchantKey("AMZN Mktp SG")).toBe("AMAZON");
		expect(merchantKey("NETFLIX.COM SINGAPORE")).toBe("NETFLIX");
	});

	it("lets a playbook alias win", () => {
		expect(merchantKey("FAST RETAILING SG", [{ pattern: "FAST RETAILING", canonical: "UNIQLO" }])).toBe("UNIQLO");
		expect(merchantKey("Shop 42 Pte Ltd", [{ pattern: "/^SHOP \\d+/", canonical: "CORNER SHOP" }])).toBe("CORNER SHOP");
	});

	it("keeps short numbers that are part of a name, and Chinese text", () => {
		expect(merchantKey("7-ELEVEN 12345")).toBe("7 ELEVEN");
		expect(merchantSimilarity(merchantKey("7-ELEVEN"), merchantKey("7ELEVEN"))).toBe(0.95);
		expect(merchantKey("全家便利商店 台北市")).toBe("全家便利商店 台北市");
	});

	it("scores similarity", () => {
		expect(merchantSimilarity("NETFLIX", "NETFLIX")).toBe(1);
		expect(merchantSimilarity("STARBUCKS", "STARBUCKS COFFEE")).toBe(0.8);
		expect(merchantSimilarity("SHOPEE", "SHOPEE MP")).toBe(0.8);
		expect(merchantSimilarity("全家便利商店", "全家便利商店 台北市")).toBe(0.8);
		expect(merchantSimilarity("GRAB", "STARBUCKS COFFEE")).toBe(0);
		expect(merchantSimilarity("", "GRAB")).toBe(0);
		// One word shared out of three distinct: 1/3.
		expect(merchantSimilarity("BLUE CAFE", "RED CAFE")).toBeCloseTo(1 / 3);
	});
});
