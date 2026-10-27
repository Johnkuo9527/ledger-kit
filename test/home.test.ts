/// The owner's home: the currency every total is in and the time zone every
/// "day" is counted in, chosen at install (LEDGER_HOME_CURRENCY, LEDGER_TIMEZONE).
/// Expected instants are worked by hand from each zone's published rules.

import { afterAll, describe, expect, it } from "vitest";
import { dayStart, home, homeCurrency, homeMoney, homeProblems, localClockText, localDate, localHour, localTime, localWeekday, makeHome, setHome, SINGAPORE } from "../src/home";

const at = (iso: string) => new Date(iso);
afterAll(() => setHome(SINGAPORE));

describe("choosing a home", () => {
	it("accepts an ISO 4217 currency and an IANA time zone, upper-casing the code", () => {
		expect(makeHome("eur", "Europe/Berlin", "de")).toEqual({ currency: "EUR", timeZone: "Europe/Berlin", country: "DE" });
		expect(makeHome("JPY", "Asia/Tokyo", "JP")).toEqual({ currency: "JPY", timeZone: "Asia/Tokyo", country: "JP" });
		expect(makeHome("USD", "UTC", "US")).toEqual({ currency: "USD", timeZone: "UTC", country: "US" });
	});

	it("refuses what it cannot keep honestly, saying why in plain words", () => {
		expect(homeProblems("EURO", "Europe/Berlin", "DE")[0]).toMatch(/3-letter/);
		expect(homeProblems("XYZ", "Europe/Berlin", "DE")[0]).toMatch(/not a currency/);
		// Kuwaiti dinar has 3 decimals (ISO 4217): refused as a HOME currency (a
		// foreign purchase in it is still fine — money.ts keeps 3 decimals).
		expect(homeProblems("KWD", "Asia/Kuwait", "KW")[0]).toMatch(/3 decimals/);
		expect(homeProblems("SGD", "Mars/Olympus", "SG")[0]).toMatch(/time zone/);
		expect(homeProblems("SGD", "UTC+8", "SG")[0]).toMatch(/time zone/);
		expect(homeProblems("SGD", "Asia/Singapore", "XX")[0]).toMatch(/LEDGER_HOME_COUNTRY/);
		expect(homeProblems("SGD", "Asia/Singapore", "ZZ")[0]).toMatch(/LEDGER_HOME_COUNTRY/); // "Unknown Region" to Intl
		expect(homeProblems("SGD", "Asia/Singapore", "SGP")[0]).toMatch(/2-letter/);
		expect(homeProblems(undefined, undefined, undefined)).toHaveLength(3);
		expect(() => makeHome("SGD", "", "SG")).toThrow(/LEDGER_TIMEZONE/);
	});

	it("is the one place the currency comes from", () => {
		setHome(makeHome("EUR", "Europe/Berlin", "DE"));
		expect(homeCurrency()).toBe("EUR");
		// 1250 minor units of EUR = 12.50.
		expect(homeMoney(1250)).toEqual({ currency: "EUR", minor: 1250, display: "EUR 12.50" });
		setHome(makeHome("JPY", "Asia/Tokyo", "JP"));
		// JPY has no decimals: 1250 minor units = ¥1,250.
		expect(homeMoney(1250).display).toBe("JPY 1,250");
		setHome(SINGAPORE);
		expect(home()).toEqual({ currency: "SGD", timeZone: "Asia/Singapore", country: "SG" });
	});
});

describe("Singapore (UTC+8, no daylight saving) — today's behaviour", () => {
	it("a day turns at 16:00 UTC", () => {
		setHome(SINGAPORE);
		expect(localDate(at("2026-10-09T15:59:59Z"))).toBe("2026-10-09");
		expect(localDate(at("2026-10-09T16:00:00Z"))).toBe("2026-10-10");
		expect(localTime(at("2026-03-05T00:15:00Z"))).toBe("08:15");
		expect(dayStart("2026-10-10").toISOString()).toBe("2026-10-09T16:00:00.000Z");
		// 2026-10-09 is a Friday; 02:00 UTC is 10:00 in Singapore.
		expect(localWeekday(at("2026-10-09T02:00:00Z"))).toBe(5);
		expect(localHour(at("2026-10-09T02:00:00Z"))).toBe(10);
	});
});

describe("Tokyo (UTC+9): a month and a year turn at 15:00 UTC", () => {
	it("New Year's Eve", () => {
		setHome(makeHome("JPY", "Asia/Tokyo", "JP"));
		expect(localDate(at("2026-12-31T14:59:00Z"))).toBe("2026-12-31");
		expect(localDate(at("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
		expect(dayStart("2027-01-01").toISOString()).toBe("2026-12-31T15:00:00.000Z");
	});
});

describe("Berlin across both 2026 clock changes", () => {
	// CET = UTC+1, CEST = UTC+2. Clocks go 02:00 → 03:00 on Sun 29 Mar 2026
	// (01:00 UTC) and 03:00 → 02:00 on Sun 25 Oct 2026 (01:00 UTC).
	it("the day a purchase falls on follows the clock change", () => {
		setHome(makeHome("EUR", "Europe/Berlin", "DE"));
		// 23:30 UTC on 28 Mar, still CET: 00:30 on the 29th.
		expect(localDate(at("2026-03-28T23:30:00Z"))).toBe("2026-03-29");
		// 22:30 UTC on 29 Mar is CEST: 00:30 on the 30th (a fixed +1 would say 23:30 on the 29th).
		expect(localDate(at("2026-03-29T22:30:00Z"))).toBe("2026-03-30");
		expect(localTime(at("2026-03-29T00:59:00Z"))).toBe("01:59");
		expect(localTime(at("2026-03-29T01:00:00Z"))).toBe("03:00");
		// After the change back: 23:30 UTC on 25 Oct is CET, 00:30 on the 26th.
		expect(localDate(at("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
	});

	it("a day starts at local midnight: 23 hours in March, 25 in October", () => {
		setHome(makeHome("EUR", "Europe/Berlin", "DE"));
		expect(dayStart("2026-03-29").toISOString()).toBe("2026-03-28T23:00:00.000Z");
		expect(dayStart("2026-03-30").toISOString()).toBe("2026-03-29T22:00:00.000Z");
		expect(dayStart("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
		expect(dayStart("2026-10-26").toISOString()).toBe("2026-10-25T23:00:00.000Z");
		// A month's window: April starts 31 Mar 22:00 UTC (CEST).
		expect(dayStart("2026-04-01").toISOString()).toBe("2026-03-31T22:00:00.000Z");
	});
});

describe("New York (EST UTC−5 / EDT UTC−4)", () => {
	it("2 a.m. on 8 Mar 2026 does not exist", () => {
		setHome(makeHome("USD", "America/New_York", "US"));
		expect(localTime(at("2026-03-08T06:59:00Z"))).toBe("01:59");
		expect(localTime(at("2026-03-08T07:00:00Z"))).toBe("03:00");
		expect(dayStart("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
		expect(dayStart("2026-03-09").toISOString()).toBe("2026-03-09T04:00:00.000Z");
		// 03:30 UTC on 1 Mar is still 28 Feb in New York (22:30 EST).
		expect(localDate(at("2026-03-01T03:30:00Z"))).toBe("2026-02-28");
	});
});

describe("a zone whose midnight was skipped", () => {
	it("São Paulo, 4 Nov 2018: clocks went 00:00 → 01:00, so the day began at 01:00 (03:00 UTC)", () => {
		setHome(makeHome("BRL", "America/Sao_Paulo", "BR"));
		// Before: UTC−3, so 00:00 local = 03:00 UTC; at 03:00 UTC the clock read 01:00 (UTC−2).
		expect(dayStart("2018-11-04").toISOString()).toBe("2018-11-04T03:00:00.000Z");
		expect(localDate(dayStart("2018-11-04"))).toBe("2018-11-04");
		expect(localDate(new Date(dayStart("2018-11-04").getTime() - 1))).toBe("2018-11-03");
	});
});

describe("clock wording in alarms", () => {
	it("names the zone and the LOCAL date", () => {
		setHome(makeHome("USD", "America/New_York", "US"));
		// 01:30 UTC on 2 Oct is 21:30 EDT on 1 Oct.
		expect(localClockText("2026-10-02T01:30:00.000Z")).toBe("21:30 on 2026-10-01 (America/New_York time)");
		setHome(SINGAPORE);
		expect(localClockText("2026-10-02T01:30:00.000Z")).toBe("09:30 on 2026-10-02 (Asia/Singapore time)");
	});
});
