/// The whole engine at two other homes: EUR in Berlin (daylight saving) and JPY
/// in Tokyo (no decimals). Taps, alerts, cash, a statement, the month's totals —
/// every figure in the owner's own currency, every day his own. Every account,
/// merchant and rate is MADE UP; every expected figure is worked by hand first.

import { afterEach, describe, expect, it } from "vitest";
import { addCash, getLine, ingestEvidence, ingestStatement, ingestTap, type Engine, type EvidenceIn } from "../src/engine";
import { makeHome, setHome, SINGAPORE } from "../src/home";
import { overview } from "../src/queries";
import { ACCOUNT_INSERT, accountValues } from "../src/seed";
import { walletKey } from "../src/shortcut";
import { isOverseas } from "../src/trips";
import type { Account } from "../src/types";
import { account } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";

let db: TestDb;
afterEach(() => {
	db?.close();
	setHome(SINGAPORE);
});

async function world(accounts: readonly Account[], wallet: [string, string], rates: [string, string, number][], quote: string): Promise<Engine> {
	db = freshDb();
	for (const a of accounts) await db.prepare(ACCOUNT_INSERT).bind(...accountValues(a)).run();
	await db.prepare("INSERT INTO account_wallet_names (wallet_key, account_id) VALUES (?, ?)").bind(walletKey(wallet[0]), wallet[1]).run();
	for (const [date, ccy, rate] of rates) await db.prepare("INSERT INTO fx_rates (date, currency, quote, rate, source) VALUES (?, ?, ?, ?, 'test')").bind(date, ccy, quote, rate).run();
	let ids = 0;
	let tick = 0;
	return { db, now: () => new Date(Date.UTC(2026, 3, 2, 0, 0, 0, tick++)).toISOString(), newId: () => `id-${String(++ids).padStart(4, "0")}`, ownNames: ["ALEX DOE"], aliases: [], actor: "rules" };
}

const alert = (over: Partial<EvidenceIn> & Pick<EvidenceIn, "fingerprint" | "institution" | "last4" | "txn_date" | "currency" | "amount_minor">): EvidenceIn => ({
	type: "alert",
	merchant_raw: "TEST",
	kind_hint: "purchase",
	...over,
});
const lineOf = async (r: unknown) => (await getLine(db, (r as { line_id: string }).line_id))!;

describe("EUR, Europe/Berlin", () => {
	const CARD = account({ id: "card-eu", institution: "examplebank", kind: "credit_card", currency: "EUR", last4: "7001", name: "Example Euro card" });
	const CASH = account({ id: "cash-eu", institution: "cash", kind: "cash", currency: "EUR", alerts_expected: 0, has_statements: 0 });

	it("a month of taps, an alert in dollars, cash in pounds and the card's statement — all in euros, on Berlin days", async () => {
		setHome(makeHome("EUR", "Europe/Berlin", "DE"));
		// Rates stored X → EUR: 1 USD = 0.92 EUR (30 Mar), 1 GBP = 1.16 EUR (31 Mar).
		const e = await world([CARD, CASH], ["Example Euro Card", CARD.id], [["2026-03-30", "USD", 0.92], ["2026-03-31", "GBP", 1.16]], "EUR");

		// 1. A tap at 23:30 UTC on 28 Mar = 00:30 CET on Sunday the 29th: "12,50 €" = 1250 cents, no conversion.
		const t1 = await ingestTap(e, { card: "Example Euro Card", merchant: "Bäckerei Beispiel", amount: "12,50 €", timestamp: "2026-03-28T23:30:00Z" });
		expect(t1.status).toBe("created");
		expect(await lineOf(t1)).toMatchObject({ txn_date: "2026-03-29", orig_currency: "EUR", orig_minor: 1250, bill_currency: "EUR", bill_minor: 1250, home_minor: 1250 });

		// 2. A dollar purchase by alert on the 30th: USD 20.00 × 0.92 × (1 + 3.25% default) = 18.998 EUR → 1900 cents, an estimate.
		const a1 = await ingestEvidence(e, alert({ fingerprint: "eu-a1", institution: "examplebank", last4: "7001", txn_date: "2026-03-30", currency: "USD", amount_minor: 2000, merchant_raw: "EXAMPLE STORE NEW YORK US" }));
		expect(await lineOf(a1)).toMatchObject({ orig_currency: "USD", bill_currency: "EUR", bill_minor: 1900, bill_status: "estimate", home_minor: 1900, home_status: "estimate", markup_source: "bank_default" });

		// 3. Cash in pounds on the 31st: GBP 10.00 × 1.16 = 11.60 EUR → 1160 cents at the reference rate.
		const cash = await addCash(e, { txn_date: "2026-03-31", currency: "GBP", amount_minor: 1000, merchant: "Example Market London", category: "Food" });
		expect(cash).toMatchObject({ home_minor: 1160, home_status: "reference" });

		// 4. A tap at 22:30 UTC on 31 Mar = 00:30 CEST on 1 April (the clocks went forward on the 29th): April, not March.
		const t2 = await ingestTap(e, { card: "Example Euro Card", merchant: "Kiosk Beispiel", amount: "5,00 €", timestamp: "2026-03-31T22:30:00Z" });
		expect(await lineOf(t2)).toMatchObject({ txn_date: "2026-04-01", home_minor: 500 });

		// 5. The card's March statement: the tap 12.50, the dollar purchase billed EUR 19.10.
		//    Net 1250 + 1910 = 3160 = closing 3160 − opening 0. ✓
		const st = await ingestStatement(
			e,
			{ account_id: CARD.id, period_start: "2026-03-01", period_end: "2026-03-31", currency: "EUR", opening_balance_minor: 0, closing_balance_minor: 3160, printed_net_minor: null },
			[
				{ seq: 1, txn_date: "2026-03-29", currency: "EUR", amount_minor: 1250, merchant_raw: "BAECKEREI BEISPIEL BERLIN", kind_hint: "purchase" },
				{ seq: 2, txn_date: "2026-03-30", currency: "USD", amount_minor: 2000, bill_currency: "EUR", bill_minor: 1910, merchant_raw: "EXAMPLE STORE NEW YORK US", merchant_country: "US", kind_hint: "purchase" },
			],
		);
		expect(st).toMatchObject({ status: "imported", recon: { ok: true, difference_minor: 0 } });
		// The estimate becomes what was billed: 19.10 EUR. Effective 19.10 ÷ 20 = 0.955; 0.955 ÷ 0.92 − 1 = 0.0380434…
		const confirmed = await lineOf(a1);
		expect(confirmed).toMatchObject({ bill_minor: 1910, bill_status: "confirmed", home_minor: 1910, home_status: "confirmed" });
		expect(confirmed.observed_markup).toBeCloseTo(0.0380435, 6);
		expect(await lineOf(t1)).toMatchObject({ home_minor: 1250, state: "reconciled" });

		// 6. March in euros: 12.50 + 19.10 + 11.60 = 43.20 EUR; 11.60 of it at a reference rate.
		const march = await overview(db, "2026-03", "2026-04-02");
		expect(march.totals.spending_home).toEqual({ currency: "EUR", minor: 4320, display: "EUR 43.20" });
		expect(march.totals.unconfirmed_home).toEqual({ currency: "EUR", minor: 1160, display: "EUR 11.60" });
		const april = await overview(db, "2026-04", "2026-04-02");
		expect(april.totals.spending_home.display).toBe("EUR 5.00");

		// Abroad means outside Germany or not in euros.
		expect(isOverseas({ orig_currency: "EUR", merchant_country: "DE" })).toBe(false);
		expect(isOverseas({ orig_currency: "EUR", merchant_country: "FR" })).toBe(true);
		expect(isOverseas({ orig_currency: "USD", merchant_country: null })).toBe(true);
	});
});

describe("JPY, Asia/Tokyo", () => {
	const CARD = account({ id: "card-jp", institution: "examplebank", kind: "credit_card", currency: "JPY", last4: "8001", name: "Example yen card" });

	it("whole yen, and New Year's Eve turns at 15:00 UTC", async () => {
		setHome(makeHome("JPY", "Asia/Tokyo", "JP"));
		// Rates stored X → JPY: 1 USD = 150 JPY (30 Dec).
		const e = await world([CARD], ["Example Yen Card", CARD.id], [["2026-12-30", "USD", 150]], "JPY");

		// A dollar alert on 30 Dec: USD 10.00 × 150 × 1.0325 = 1,548.75 yen → 1,549 (yen has no decimals).
		const a1 = await ingestEvidence(e, alert({ fingerprint: "jp-a1", institution: "examplebank", last4: "8001", txn_date: "2026-12-30", currency: "USD", amount_minor: 1000, merchant_raw: "EXAMPLE APP STORE US" }));
		expect(await lineOf(a1)).toMatchObject({ bill_currency: "JPY", bill_minor: 1549, home_minor: 1549, home_status: "estimate" });

		// A tap at 15:30 UTC on 31 Dec = 00:30 on 1 Jan 2027 in Tokyo: "¥1,200" = 1200 yen.
		const t1 = await ingestTap(e, { card: "Example Yen Card", merchant: "Konbini Example", amount: "¥1,200", timestamp: "2026-12-31T15:30:00Z" });
		expect(await lineOf(t1)).toMatchObject({ txn_date: "2027-01-01", bill_minor: 1200, home_minor: 1200 });

		const dec = await overview(db, "2026-12", "2027-01-02");
		expect(dec.totals.spending_home).toEqual({ currency: "JPY", minor: 1549, display: "JPY 1,549" });
		const jan = await overview(db, "2027-01", "2027-01-02");
		expect(jan.totals.spending_home).toEqual({ currency: "JPY", minor: 1200, display: "JPY 1,200" });
	});
});

describe("SGD, Asia/Singapore — the kit's first home, unchanged", () => {
	it("a tap at 16:30 UTC is the next Singapore day, and totals are in SGD", async () => {
		setHome(SINGAPORE);
		const CARD = account({ id: "card-sg", institution: "hsbc", kind: "credit_card", currency: "SGD", last4: "9101" });
		const e = await world([CARD], ["Example SG Card", CARD.id], [], "SGD");
		const t1 = await ingestTap(e, { card: "Example SG Card", merchant: "Kopi Example", amount: "S$4.50", timestamp: "2026-10-08T16:30:00Z" });
		expect(await lineOf(t1)).toMatchObject({ txn_date: "2026-10-09", home_minor: 450 });
		const oct = await overview(db, "2026-10", "2026-10-09");
		expect(oct.totals.spending_home).toEqual({ currency: "SGD", minor: 450, display: "SGD 4.50" });
	});
});
