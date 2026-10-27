/// Amounts as people's phones and banks print them around the world. Each row's
/// expected minor units is worked by hand: the figure written out in the
/// currency's smallest unit (cents, or whole yen for JPY).

import { afterEach, describe, expect, it } from "vitest";
import { makeHome, setHome, SINGAPORE } from "../src/home";
import { parsePrinted } from "../src/money";
import { parseTap, parseTapAmount } from "../src/shortcut";
import { parseSmsLocally } from "../src/wallet-sms";

afterEach(() => setHome(SINGAPORE));

describe("a printed amount, whatever the locale", () => {
	const rows: [string, string, number][] = [
		["12.50", "EUR", 1250],
		["12,50", "EUR", 1250], // de/fr/es: comma is the decimal point
		["12,5", "EUR", 1250],
		["0,99", "EUR", 99],
		["1.234,56", "EUR", 123456], // de: dots group thousands
		["1 234,56", "EUR", 123456], // fr: a space groups thousands
		["1 234,56", "EUR", 123456], // fr on iOS: a narrow no-break space
		["1 234,56", "EUR", 123456], // a no-break space
		["1,234.56", "USD", 123456],
		["1'234.50", "CHF", 123450], // de-CH: an apostrophe groups thousands
		["1’234.50", "CHF", 123450],
		["1,23,456.00", "INR", 12345600], // en-IN: lakh grouping
		["1,200", "SGD", 120000], // three digits after a lone comma: thousands
		["1.200", "EUR", 120000], // and after a lone dot too
		["1.200", "JPY", 1200], // yen has no decimals: 1,200 yen
		["1,200.00", "JPY", 1200], // yen printed with ".00"
		["1.234.567", "IDR", 123456700],
		["1.234", "KWD", 1234], // a 3-decimal currency: 1.234 dinar = 1,234 fils
		["−3,00", "EUR", -300], // a minus sign (U+2212)
	];
	it.each(rows)("%s %s → %i", (text, currency, minor) => {
		expect(parsePrinted(text, currency)).toBe(minor);
	});

	it("refuses what it cannot read without guessing", () => {
		expect(() => parsePrinted("12,505", "KWD")).not.toThrow(); // 12.505 dinar: fine
		expect(() => parsePrinted("12.345,6.7", "EUR")).toThrow();
		expect(() => parsePrinted("1,2,3", "EUR")).toThrow(); // groups that are not 3 digits
		expect(() => parsePrinted("12.50", "JPY")).toThrow(/decimals/); // yen with cents
		expect(() => parsePrinted("EUR 12", "EUR")).toThrow(); // a currency is not part of the figure
		expect(() => parsePrinted("", "EUR")).toThrow();
	});
});

describe("an Apple Pay tap's amount, as Wallet prints it in each locale", () => {
	const rows: [string, string | undefined, string, string, number][] = [
		// [amount text, currency field, home, expected currency, minor]
		["S$4.50", undefined, "SGD", "SGD", 450],
		["€12.50", undefined, "EUR", "EUR", 1250], // en-IE
		["12,50 €", undefined, "EUR", "EUR", 1250], // de-DE: symbol after, comma decimal
		["12,50 €", undefined, "EUR", "EUR", 1250],
		["1.234,56 €", undefined, "EUR", "EUR", 123456],
		["1 234,56 €", undefined, "EUR", "EUR", 123456], // fr-FR
		["-12,50 €", undefined, "EUR", "", 0], // a tap is never negative: refused
		["£3.20", undefined, "GBP", "GBP", 320],
		["$4.50", undefined, "USD", "USD", 450], // en-US: a bare $ is the home dollar
		["$4.50", undefined, "AUD", "AUD", 450], // en-AU
		["$4.50", "CAD", "USD", "CAD", 450], // the currency field always wins over a bare $
		["$4.50", undefined, "EUR", "", 0], // a bare $ with a euro home: which dollar? refused
		["US$12.00", undefined, "SGD", "USD", 1200],
		["12.00 USD", undefined, "EUR", "USD", 1200], // a code after the figure
		["USD 12.00", undefined, "EUR", "USD", 1200],
		["¥1,200", undefined, "JPY", "JPY", 1200],
		["￥1,200", undefined, "SGD", "JPY", 1200],
		["1.200 ¥", undefined, "JPY", "JPY", 1200], // de-DE showing yen
		["¥58.00", undefined, "CNY", "CNY", 5800], // zh-CN: ¥ is the yuan at a yuan home
		["NT$1,500", undefined, "TWD", "TWD", 150000],
		["$1,500", undefined, "TWD", "TWD", 150000], // zh-TW prints NT dollars as $
		["A$5.00", undefined, "SGD", "AUD", 500],
		["R$ 10,90", undefined, "BRL", "BRL", 1090], // pt-BR
		["CHF 1'234.50", undefined, "CHF", "CHF", 123450], // de-CH
		["99,00 kr", "SEK", "SEK", "SEK", 9900], // sv-SE
		["99,00 kr", undefined, "SEK", "SEK", 9900], // kr at a Swedish home is the krona
		["99,00 kr", undefined, "EUR", "", 0], // kr at a euro home: SEK, NOK or DKK? refused
		["₹1,23,456.00", undefined, "INR", "INR", 12345600],
		["4.50", "SGD", "SGD", "SGD", 450],
		["4.50", undefined, "GBP", "GBP", 450], // no symbol at all: the home currency
		["€12.50", "USD", "EUR", "", 0], // says euro, field says dollar: refused
	];
	it.each(rows)("%s (field %s, home %s) → %s %i", (text, field, homeCcy, currency, minor) => {
		setHome(makeHome(homeCcy, "UTC", "US"));
		const got = parseTapAmount(text, field);
		if (!currency) expect(typeof got).toBe("string");
		else expect(got).toEqual({ currency, minor });
	});
});

describe("a tap's day and time are the owner's, daylight saving included", () => {
	it("Berlin: 22:30 UTC on 29 Mar 2026 is 00:30 on the 30th (CEST, UTC+2)", () => {
		setHome(makeHome("EUR", "Europe/Berlin", "DE"));
		const t = parseTap({ card: "Example Card", merchant: "Bäckerei Beispiel", amount: "3,40 €", timestamp: "2026-03-29T22:30:00Z" });
		expect(t).toMatchObject({ currency: "EUR", amount_minor: 340, txn_date: "2026-03-30", txn_time: "00:30" });
	});
	it("New York: an iPhone timestamp with its own offset lands on the New York day", () => {
		setHome(makeHome("USD", "America/New_York", "US"));
		const t = parseTap({ card: "Example Card", merchant: "Corner Deli", amount: "$8.25", timestamp: "2026-11-01T01:30:00-04:00" });
		// 01:30 EDT on 1 Nov (the first of the two 01:30s that night) = 05:30 UTC.
		expect(t).toMatchObject({ currency: "USD", amount_minor: 825, txn_date: "2026-11-01", txn_time: "01:30" });
	});
});

describe("a shop's SMS in another locale", () => {
	it("comma decimals, a euro sign before or after, still exactly one spend and one balance", () => {
		// 12,50 € spent = 1250 cents; 87,50 € left = 8750 cents.
		expect(parseSmsLocally("Beispiel Café: Spent 12,50 €, Balance 87,50 €", "EUR")).toEqual({ kind: "spend", spent_minor: 1250, balance_minor: 8750 });
		expect(parseSmsLocally("Amount Deducted: €1.012,50 Remaining Balance: €2.000,00", "EUR")).toEqual({ kind: "spend", spent_minor: 101250, balance_minor: 200000 });
		// A word after the label is not a currency code: never read as money (the reading desk reads it).
		expect(parseSmsLocally("Spent for 12.00, Balance for 30.00", "EUR")).toBeNull();
		expect(parseSmsLocally("Spent pts 120 Balance pts 300", "SGD")).toBeNull();
		// Yen: 1,200 used, 8,800 left.
		expect(parseSmsLocally("消費 ¥1,200 餘額 ¥8,800", "JPY")).toEqual({ kind: "spend", spent_minor: 1200, balance_minor: 8800 });
	});
});
