/// The owner's language (LEDGER_LANGUAGE, chosen at install) and how money and
/// days read in it (src/words.ts). Expected strings are written out by hand from
/// the owner's locale conventions (CLDR, which Intl carries): a Singapore reader
/// writes his own dollars "$4.50" and a German home's euros read "€12.50".

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHome, setHome, SINGAPORE } from "../src/home";
import { catalogue, currencyName, languageProblem, LANGUAGES, language, pageWordsScript, say, sayDate, sayDayMonth, sayMoney, sayMonth, setLanguage, type Language } from "../src/words";

const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;
const placeholders = (e: unknown): string[] => {
	const texts = typeof e === "string" ? [e] : Object.values(e as Record<string, string>);
	return [...new Set(texts.flatMap((t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();
};

afterEach(() => {
	setHome(SINGAPORE);
	setLanguage("zh-Hant");
});

describe("choosing the language", () => {
	it("takes English or Traditional Chinese, English when nothing is set", () => {
		expect(LANGUAGES).toEqual(["en", "zh-Hant"]);
		expect(languageProblem("en")).toBeNull();
		expect(languageProblem("zh-Hant")).toBeNull();
		expect(languageProblem(undefined)).toBeNull(); // the kit's default: English
		expect(languageProblem("")).toBeNull();
		expect(languageProblem("fr")).toMatch(/LEDGER_LANGUAGE.*en.*zh-Hant/);
		expect(languageProblem("zh-TW")).toMatch(/LEDGER_LANGUAGE/);
		setLanguage("en");
		expect(language()).toBe("en");
	});
});

describe("one catalogue per language", () => {
	const en = catalogue("en");
	const zh = catalogue("zh-Hant");

	it("every key exists in both languages, with the same blanks to fill", () => {
		expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
		for (const key of Object.keys(en)) expect([key, placeholders(zh[key as keyof typeof zh])]).toEqual([key, placeholders(en[key as keyof typeof en])]);
	});

	it("English has no Chinese in it", () => {
		const bad = Object.entries(en).filter(([, v]) => CJK.test(JSON.stringify(v)));
		expect(bad).toEqual([]);
	});

	it("a count picks its English form; Chinese has one", () => {
		setLanguage("en");
		expect(say("page.lines.count", { n: 1 })).toBe("1 line");
		expect(say("page.lines.count", { n: 3 })).toBe("3 lines");
		setLanguage("zh-Hant");
		expect(say("page.lines.count", { n: 3 })).toBe("3 筆");
	});

	it("the page's own words go to the page, both languages, prefix dropped", () => {
		const script = pageWordsScript();
		expect(script).toContain("window.LEDGER_WORDS");
		const onlyEn = pageWordsScript(["en"]);
		expect(onlyEn).toContain('"lines.count"');
		expect(onlyEn).not.toContain("zh-Hant");
	});

	it("every word the page asks for by name is in the catalogue (page/app.js and index.html)", () => {
		const app = readFileSync(new URL("../page/app.js", import.meta.url), "utf8");
		const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8");
		const asked = new Set([...app.matchAll(/\bsay\("([\w.]+)"[,)]/g), ...html.matchAll(/data-say(?:-aria|-title|-placeholder)?="([\w.]+)"/g)].map((m) => m[1]!));
		expect(asked.size).toBeGreaterThan(300);
		const missing = [...asked].filter((k) => !(`page.${k}` in en));
		expect(missing).toEqual([]);
	});

	it("page/words.js is the catalogue as it is now (run `npm run words` after changing a catalogue)", () => {
		const file = readFileSync(new URL("../page/words.js", import.meta.url), "utf8");
		expect(file).toBe(pageWordsScript());
	});
});

describe("money in the owner's locale and home currency", () => {
	const as = (lang: Language, currency: string, tz: string, country: string) => {
		setLanguage(lang);
		setHome(makeHome(currency, tz, country));
	};

	it("a German home in English: euros with the euro sign", () => {
		as("en", "EUR", "Europe/Berlin", "DE");
		expect(sayMoney(1250, "EUR")).toBe("€12.50");
		expect(sayMoney(-1250, "EUR")).toBe("−€12.50");
		expect(sayMoney(450, "USD")).toBe("US$4.50");
	});

	it("a Japanese home: yen has no decimals", () => {
		as("en", "JPY", "Asia/Tokyo", "JP");
		expect(sayMoney(1200, "JPY")).toBe("¥1,200");
	});

	it("Singapore in English: his own dollars are plain $, others say whose", () => {
		as("en", "SGD", "Asia/Singapore", "SG");
		expect(sayMoney(450, "SGD")).toBe("$4.50");
		expect(sayMoney(123456, "SGD")).toBe("$1,234.56");
		expect(sayMoney(450, "USD")).toBe("US$4.50");
		expect(sayMoney(1200, "JPY")).toBe("JP¥1,200");
	});

	it("Singapore in Chinese: the home dollar is $ too (Intl writes SGD out, the owner knows his own)", () => {
		as("zh-Hant", "SGD", "Asia/Singapore", "SG");
		expect(sayMoney(450, "SGD")).toBe("$4.50");
		expect(sayMoney(450, "USD")).toBe("US$4.50");
		// zh-Hant writes Taiwan's dollar as a bare "$" too: a foreign currency that would look like the
		// home's own takes the English mark instead, so a TWD card never reads as Singapore dollars.
		expect(sayMoney(30000, "TWD")).toBe("NT$300.00");
	});

	it("a currency's name, for words like 'no rate to convert to …'", () => {
		as("en", "EUR", "Europe/Berlin", "DE");
		expect(currencyName("EUR")).toBe("Euro");
		setLanguage("zh-Hant");
		expect(currencyName("SGD")).toBe("新加坡幣");
	});
});

describe("days in the owner's locale", () => {
	it("English writes 12 Oct 2026; Chinese 2026年10月12日", () => {
		setLanguage("en");
		setHome(makeHome("EUR", "Europe/Berlin", "DE"));
		expect(sayDate("2026-10-12")).toBe("12 Oct 2026");
		expect(sayDayMonth("2026-10-12")).toBe("12 Oct");
		expect(sayMonth("2026-10")).toBe("October 2026");
		setLanguage("zh-Hant");
		setHome(SINGAPORE);
		expect(sayDate("2026-10-12")).toBe("2026年10月12日");
		expect(sayDayMonth("2026-10-12")).toBe("10月12日");
		expect(sayMonth("2026-10")).toBe("2026年10月");
	});
});
