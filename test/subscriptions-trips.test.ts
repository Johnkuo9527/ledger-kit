import { describe, expect, it } from "vitest";
import { reimbursable, reimbursableTotal, rangeProblem } from "../src/reimbursable";
import { detectSubscriptions, monthlyEquivalent, type SubLine } from "../src/subscriptions";
import { canMoveTrip, isOverseas, planProposals, proposeTrips, tripLines, tripTotalHome, type TravelEvidence } from "../src/trips";
import type { LineRow } from "../src/types";
import { line } from "./helpers/fixtures";

let k = 0;
const charge = (merchant: string, date: string, minor: number, currency = "SGD"): SubLine => ({
	id: `s${++k}`,
	kind: "purchase",
	state: "posted",
	txn_date: date,
	merchant_key: merchant,
	merchant_name: merchant,
	orig_currency: currency,
	orig_minor: minor,
});

describe("subscriptions", () => {
	it("finds a monthly charge and its price rise", () => {
		const lines = [
			charge("STREAMFLIX", "2026-01-15", 1598),
			charge("STREAMFLIX", "2026-02-15", 1598),
			charge("STREAMFLIX", "2026-03-16", 1598), // a day late is still monthly
			charge("STREAMFLIX", "2026-04-15", 1598),
			charge("STREAMFLIX", "2026-05-15", 1798), // the rise
		];
		const [s, ...rest] = detectSubscriptions(lines, "2026-05-20");
		expect(rest).toHaveLength(0);
		expect(s).toMatchObject({
			merchant_key: "STREAMFLIX",
			cadence: "monthly",
			amount_minor: 1798,
			previous_amount_minor: 1598,
			price_changed_on: "2026-05-15",
			first_seen: "2026-01-15",
			last_charged: "2026-05-15",
			next_renewal: "2026-06-15",
			occurrences: 5,
			status: "active",
		});
		expect(monthlyEquivalent(s!)).toBe(1798);
	});

	it("keeps two subscriptions billed under one name apart", () => {
		const lines = [
			...["01", "02", "03", "04", "05"].map((m) => charge("APPLE", `2026-${m}-03`, 398)),
			...["02", "03", "04", "05"].map((m) => charge("APPLE", `2026-${m}-10`, 1098)),
		];
		const subs = detectSubscriptions(lines, "2026-05-20");
		expect(subs.map((s) => [s.amount_minor, s.occurrences, s.previous_amount_minor])).toEqual(
			expect.arrayContaining([
				[398, 5, null],
				[1098, 4, null],
			]),
		);
		expect(subs).toHaveLength(2);
	});

	it("joins an old price and a new price that each ran for months", () => {
		const lines = [
			...["01", "02", "03"].map((m) => charge("GYM", `2026-${m}-01`, 9900)),
			...["04", "05", "06"].map((m) => charge("GYM", `2026-${m}-01`, 11900)),
		];
		const subs = detectSubscriptions(lines, "2026-06-10");
		expect(subs).toHaveLength(1);
		expect(subs[0]).toMatchObject({ amount_minor: 11900, previous_amount_minor: 9900, price_changed_on: "2026-04-01", occurrences: 6 });
	});

	it("ignores a merchant with no rhythm", () => {
		const lines = [charge("GRAB", "2026-03-01", 1230), charge("GRAB", "2026-03-02", 870), charge("GRAB", "2026-03-09", 1230), charge("GRAB", "2026-04-20", 1230)];
		expect(detectSubscriptions(lines, "2026-05-01")).toEqual([]);
	});

	it("finds yearly and weekly rhythms", () => {
		const yearly = detectSubscriptions([charge("DOMAINCO", "2025-04-01", 2400, "USD"), charge("DOMAINCO", "2026-04-03", 2400, "USD")], "2026-05-01");
		expect(yearly[0]).toMatchObject({ cadence: "yearly", currency: "USD", next_renewal: "2027-04-01" });
		const weekly = detectSubscriptions(["03-02", "03-09", "03-16", "03-23"].map((d) => charge("VEGBOX", `2026-${d}`, 3500)), "2026-03-25");
		expect(weekly[0]).toMatchObject({ cadence: "weekly", next_renewal: "2026-03-30" });
		expect(monthlyEquivalent(weekly[0]!)).toBe(15167); // 35.00 × 52 ÷ 12 = 151.666…
	});

	it("follows a month-end anchor through February", () => {
		const subs = detectSubscriptions([charge("CLOUDBOX", "2026-01-31", 500), charge("CLOUDBOX", "2026-02-28", 500), charge("CLOUDBOX", "2026-03-31", 500)], "2026-04-02");
		expect(subs[0]).toMatchObject({ cadence: "monthly", next_renewal: "2026-04-30" });
	});

	it("calls a subscription that stopped 'lapsed'", () => {
		const subs = detectSubscriptions(["01", "02", "03"].map((m) => charge("MAGAZINE", `2026-${m}-05`, 800)), "2026-06-01");
		expect(subs[0]).toMatchObject({ status: "lapsed", next_renewal: "2026-04-05" });
	});

	it("ignores refunds, void lines and transfers", () => {
		const lines = ["01", "02", "03"].map((m) => ({ ...charge("RENT", `2026-${m}-01`, 200000), kind: "transfer" as const }));
		expect(detectSubscriptions(lines, "2026-03-05")).toEqual([]);
	});
});

describe("trips", () => {
	const tokyo: TravelEvidence = {
		evidence_id: "ev-flight",
		line_id: "flight-line",
		flights: [
			{ from: "SIN", from_country: "SG", to: "NRT", to_country: "JP", to_city: "Tokyo", date: "2026-04-10" },
			{ from: "KIX", from_country: "JP", to: "SIN", to_country: "SG", date: "2026-04-17" },
		],
		hotels: [],
	};
	const hotels: TravelEvidence = {
		evidence_id: "ev-hotel",
		line_id: "hotel-line",
		flights: [],
		hotels: [
			{ city: "Tokyo", country: "JP", check_in: "2026-04-10", check_out: "2026-04-14" },
			{ city: "Osaka", country: "JP", check_in: "2026-04-14", check_out: "2026-04-17" },
		],
	};

	it("proposes one trip from the flights and hotels", () => {
		expect(proposeTrips([tokyo, hotels])).toEqual([
			{
				destination: "Tokyo, JP · Osaka, JP",
				countries: ["JP"],
				start_date: "2026-04-10",
				end_date: "2026-04-17",
				evidence_ids: ["ev-flight", "ev-hotel"],
				booking_line_ids: ["flight-line", "hotel-line"],
				open_ended: false,
			},
		]);
	});

	it("proposes a trip home to Taiwan from flights alone, and counts an e-ticket's legs once", () => {
		const legs = [
			{ from: "SIN", from_country: "SG", to: "TPE", to_country: "TW", to_city: "Taipei", date: "2026-06-01" },
			{ from: "TPE", from_country: "TW", to: "SIN", to_country: "SG", date: "2026-06-08" },
		];
		const trips = proposeTrips([
			{ evidence_id: "booking", line_id: "air", flights: legs, hotels: [] },
			{ evidence_id: "eticket", line_id: null, flights: legs, hotels: [] },
		]);
		expect(trips).toHaveLength(1);
		expect(trips[0]).toMatchObject({ destination: "Taipei, TW", start_date: "2026-06-01", end_date: "2026-06-08", evidence_ids: ["booking"] });
	});

	it("proposes a trip from a hotel alone, but never from a staycation", () => {
		const kl: TravelEvidence = { evidence_id: "kl", line_id: null, flights: [], hotels: [{ city: "Kuala Lumpur", country: "MY", check_in: "2026-07-03", check_out: "2026-07-05" }] };
		const sg: TravelEvidence = { evidence_id: "sg", line_id: null, flights: [], hotels: [{ city: "Singapore", country: "SG", check_in: "2026-08-01", check_out: "2026-08-02" }] };
		expect(proposeTrips([kl, sg]).map((t) => [t.destination, t.start_date, t.end_date])).toEqual([["Kuala Lumpur, MY", "2026-07-03", "2026-07-05"]]);
	});

	it("marks a trip with no way home yet as open-ended, stretched by its hotel", () => {
		const out: TravelEvidence = { evidence_id: "o", line_id: null, flights: [{ from: "SIN", from_country: "SG", to: "BKK", to_country: "TH", to_city: "Bangkok", date: "2026-09-01" }], hotels: [{ city: "Bangkok", country: "TH", check_in: "2026-09-01", check_out: "2026-09-04" }] };
		expect(proposeTrips([out])[0]).toMatchObject({ open_ended: true, start_date: "2026-09-01", end_date: "2026-09-04" });
	});

	it("gathers overseas spending in the window, the bookings, and their refunds — nothing else", () => {
		const L = (o: Partial<LineRow>) => line({ orig_currency: "JPY", bill_minor: 1000, home_minor: 1000, txn_date: "2026-04-12", ...o });
		const lines = [
			L({ id: "ramen", orig_minor: 1200, home_minor: 1131 }),
			L({ id: "flight-line", orig_currency: "SGD", merchant_country: "SG", txn_date: "2026-03-01", home_minor: 68000 }),
			L({ id: "sg-subscription", orig_currency: "SGD", merchant_country: "SG", txn_date: "2026-04-15", home_minor: 1798 }),
			L({ id: "sgd-abroad", orig_currency: "SGD", merchant_country: "JP", txn_date: "2026-04-11", home_minor: 5000 }),
			L({ id: "after", txn_date: "2026-04-20", home_minor: 900 }),
			L({ id: "owner-said-no", home_minor: 7000 }),
			L({ id: "taxi-to-airport", orig_currency: "SGD", merchant_country: "SG", txn_date: "2026-04-10", home_minor: 3500 }),
			L({ id: "ramen-refund", kind: "refund", refund_of: "ramen", txn_date: "2026-04-25", home_minor: -1131 }),
			L({ id: "atm", kind: "transfer", home_minor: 20000 }),
		];
		const members = tripLines(
			{
				start_date: "2026-04-10",
				end_date: "2026-04-17",
				booking_line_ids: ["flight-line"],
				overrides: new Map([
					["owner-said-no", "excluded"],
					["taxi-to-airport", "included"],
				]),
			},
			lines,
		);
		expect(members.map((l) => l.id).sort()).toEqual(["flight-line", "ramen", "ramen-refund", "sgd-abroad", "taxi-to-airport"]);
		// 680.00 + 11.31 − 11.31 + 50.00 + 35.00 = SGD 765.00
		expect(tripTotalHome(members)).toBe(76500);
	});

	it("treats a 台新 TWD purchase in Taiwan as overseas", () => {
		expect(isOverseas({ orig_currency: "TWD", merchant_country: "TW" })).toBe(true);
		expect(isOverseas({ orig_currency: "SGD", merchant_country: null })).toBe(false);
	});

	it("never moves a trip the owner has confirmed or dismissed", () => {
		const p = proposeTrips([tokyo])[0]!;
		expect(planProposals([p], [])).toEqual({ create: [p], refresh: [] });
		expect(planProposals([p], [{ id: "t1", status: "proposed", start_date: "2026-04-09", end_date: "2026-04-12" }]).refresh).toEqual([{ trip_id: "t1", proposal: p }]);
		expect(planProposals([p], [{ id: "t1", status: "confirmed", start_date: "2026-04-09", end_date: "2026-04-12" }])).toEqual({ create: [], refresh: [] });
		expect(planProposals([p], [{ id: "t1", status: "dismissed", start_date: "2026-04-15", end_date: "2026-04-20" }])).toEqual({ create: [], refresh: [] });
	});

	it("moves proposed → confirmed or dismissed, and only those ways", () => {
		expect(canMoveTrip("proposed", "confirmed")).toBe(true);
		expect(canMoveTrip("proposed", "dismissed")).toBe(true);
		expect(canMoveTrip("dismissed", "proposed")).toBe(true);
		expect(canMoveTrip("confirmed", "proposed")).toBe(false);
		expect(canMoveTrip("dismissed", "confirmed")).toBe(false);
	});
});

describe("company-reimbursable", () => {
	const ranges = [{ id: "r1", start_date: "2026-04-10", end_date: "2026-04-17", note: "Tokyo work trip" }];

	it("marks spending inside the owner's range", () => {
		expect(reimbursable(line({ txn_date: "2026-04-10" }), ranges)).toEqual({ effective: true, source: "range", range_id: "r1" });
		expect(reimbursable(line({ txn_date: "2026-04-17" }), ranges).effective).toBe(true);
		expect(reimbursable(line({ txn_date: "2026-04-18" }), ranges).effective).toBe(false);
	});

	it("lets the owner's per-line choice win either way", () => {
		expect(reimbursable(line({ txn_date: "2026-04-12", reimbursable_override: 0 }), ranges)).toEqual({ effective: false, source: "override", range_id: null });
		expect(reimbursable(line({ txn_date: "2026-03-01", reimbursable_override: 1 }), ranges)).toEqual({ effective: true, source: "override", range_id: null });
	});

	it("never marks a transfer or card payment", () => {
		expect(reimbursable(line({ kind: "card_payment", txn_date: "2026-04-12" }), ranges).effective).toBe(false);
	});

	it("totals the claim, net of refunds", () => {
		const lines = [
			line({ txn_date: "2026-04-11", home_minor: 25000 }),
			line({ txn_date: "2026-04-12", home_minor: 4000 }),
			line({ kind: "refund", txn_date: "2026-04-13", home_minor: -1500 }),
			line({ txn_date: "2026-04-14", home_minor: 9999, reimbursable_override: 0 }),
			line({ txn_date: "2026-04-20", home_minor: 1234 }),
		];
		// 250.00 + 40.00 − 15.00 = SGD 275.00
		expect(reimbursableTotal(lines, ranges)).toBe(27500);
	});

	it("checks a range", () => {
		expect(rangeProblem("2026-04-10", "2026-04-17")).toBeNull();
		expect(rangeProblem("2026-04-17", "2026-04-10")).toMatch(/ends before/);
		expect(rangeProblem("10/04/2026", "2026-04-17")).toMatch(/YYYY-MM-DD/);
	});
});
