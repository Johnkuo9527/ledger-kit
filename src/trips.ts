/// Trips. Flight and hotel receipts PROPOSE a trip (where + from/to dates);
/// The owner confirms it, adjusting the dates if he likes. The trip then gathers:
///   * every overseas purchase inside its dates,
///   * the flight and hotel bookings themselves, whenever they were paid,
///   * refunds of any of those,
/// and nothing else — a streaming renewal at home during the trip is not
/// trip spending. Because the overseas fee is part of each purchase's billed
/// amount (src/fx.ts), the total is the true cost.
///
///   proposed ──the owner confirms──► confirmed
///      │  └────the owner dismisses──► dismissed ──the owner restores──► proposed
///   confirmed: the owner may still change dates or include/exclude lines.

import { homeCountry, homeCurrency } from "./home";
import { addDays, maxDate, minDate } from "./dates";
import { isSpending } from "./transfers";
import type { FlightLeg, HotelStay, LineRow } from "./types";

export type TripStatus = "proposed" | "confirmed" | "dismissed";
export type Membership = "auto" | "included" | "excluded";

export interface TravelEvidence {
	evidence_id: string;
	line_id: string | null; // the booking's ledger line, once paid
	flights: readonly FlightLeg[];
	hotels: readonly HotelStay[];
}

export interface TripProposal {
	destination: string;
	countries: string[];
	start_date: string;
	end_date: string;
	evidence_ids: string[];
	booking_line_ids: string[];
	open_ended: boolean; // left home, no return flight or hotel end seen yet
}

interface Window {
	start: string;
	end: string;
	open_ended: boolean;
	from_flights: boolean;
	places: string[];
	countries: Set<string>;
	evidence: Set<string>;
	lines: Set<string>;
}

function place(city: string | undefined, country: string): string {
	return city ? `${city}, ${country}` : country;
}

/// A hotel within a day of a window belongs to it (late check-in, early flight).
const HOTEL_SLACK_DAYS = 1;

export function proposeTrips(travel: readonly TravelEvidence[], home = homeCountry()): TripProposal[] {
	type Leg = FlightLeg & { evidence_id: string; line_id: string | null };
	const seen = new Set<string>();
	const legs: Leg[] = [];
	for (const t of travel) {
		for (const f of t.flights) {
			const key = `${f.from}>${f.to}@${f.date}`;
			if (seen.has(key)) continue; // the same leg on a booking and its e-ticket
			seen.add(key);
			legs.push({ ...f, evidence_id: t.evidence_id, line_id: t.line_id });
		}
	}
	legs.sort((a, b) => a.date.localeCompare(b.date) || a.from.localeCompare(b.from));

	const windows: Window[] = [];
	for (let i = 0; i < legs.length; i++) {
		const out = legs[i]!;
		if (out.from_country !== home || out.to_country === home) continue;
		const w: Window = {
			start: out.date,
			end: out.date,
			open_ended: true,
			from_flights: true,
			places: [],
			countries: new Set(),
			evidence: new Set([out.evidence_id]),
			lines: new Set(out.line_id ? [out.line_id] : []),
		};
		for (let j = i; j < legs.length; j++) {
			const leg = legs[j]!;
			if (j > i && leg.from_country === home) break; // left again without coming back: a new trip
			w.evidence.add(leg.evidence_id);
			if (leg.line_id) w.lines.add(leg.line_id);
			w.end = leg.date;
			if (leg.to_country === home) {
				w.open_ended = false;
				i = j;
				break;
			}
			w.countries.add(leg.to_country);
			const p = place(leg.to_city, leg.to_country);
			if (!w.places.includes(p)) w.places.push(p);
		}
		windows.push(w);
	}

	for (const t of travel) {
		for (const h of t.hotels) {
			if (h.country === home) continue; // a staycation is not a trip
			const overlaps = (w: Window) =>
				h.check_in <= addDays(w.end, HOTEL_SLACK_DAYS) && h.check_out >= addDays(w.start, -HOTEL_SLACK_DAYS);
			let w = windows.find(overlaps);
			if (!w) {
				w = {
					start: h.check_in,
					end: h.check_out,
					open_ended: false,
					from_flights: false,
					places: [],
					countries: new Set(),
					evidence: new Set(),
					lines: new Set(),
				};
				windows.push(w);
			}
			w.evidence.add(t.evidence_id);
			if (t.line_id) w.lines.add(t.line_id);
			w.countries.add(h.country);
			const p = place(h.city, h.country);
			if (!w.places.includes(p)) w.places.push(p);
			// A round-trip flight fixes the dates; otherwise the stays stretch them.
			if (w.open_ended || !w.from_flights) {
				w.start = minDate(w.start, h.check_in);
				w.end = maxDate(w.end, h.check_out);
			}
		}
	}

	return windows
		.sort((a, b) => a.start.localeCompare(b.start))
		.map((w) => ({
			destination: w.places.join(" · ") || [...w.countries].join(", ") || "Overseas",
			countries: [...w.countries].sort(),
			start_date: w.start,
			end_date: w.end,
			evidence_ids: [...w.evidence].sort(),
			booking_line_ids: [...w.lines].sort(),
			open_ended: w.open_ended,
		}));
}

/// Spending that happened abroad: charged in another currency than the home
/// currency, or by a merchant outside the home country (src/home.ts). (A TWD
/// card's purchase in Taiwan IS abroad for an owner at home elsewhere, unlike
/// for the overseas-fee rule in src/matching.ts.)
export function isOverseas(line: Pick<LineRow, "orig_currency" | "merchant_country">, home = homeCountry()): boolean {
	if (line.orig_currency !== homeCurrency()) return true;
	return !!line.merchant_country && line.merchant_country !== home;
}

export interface TripMembershipInput {
	start_date: string;
	end_date: string;
	booking_line_ids: readonly string[];
	/// The owner's explicit choices for this trip (line id → membership).
	overrides: ReadonlyMap<string, Exclude<Membership, "auto">>;
}

/// The ledger lines that make up a trip's cost.
export function tripLines(trip: TripMembershipInput, lines: readonly LineRow[]): LineRow[] {
	const bookings = new Set(trip.booking_line_ids);
	const members = new Set<string>();
	for (const l of lines) {
		if (!isSpending(l) || l.kind === "refund") continue;
		const choice = trip.overrides.get(l.id);
		if (choice === "excluded") continue;
		const inWindow = l.txn_date >= trip.start_date && l.txn_date <= trip.end_date && isOverseas(l);
		if (choice === "included" || bookings.has(l.id) || inWindow) members.add(l.id);
	}
	// A refund belongs wherever its purchase does.
	return lines.filter((l) => members.has(l.id) || (l.kind === "refund" && l.state !== "void" && l.refund_of !== null && members.has(l.refund_of) && trip.overrides.get(l.id) !== "excluded"));
}

export function tripTotalHome(lines: readonly LineRow[]): number {
	return lines.reduce((sum, l) => sum + l.home_minor, 0);
}

/// Which proposals are new, and which only refresh a trip already proposed.
/// A trip the owner has confirmed or dismissed is his: new evidence never moves it.
export interface ExistingTrip {
	id: string;
	status: TripStatus;
	start_date: string;
	end_date: string;
}

export function planProposals(
	proposals: readonly TripProposal[],
	existing: readonly ExistingTrip[],
): { create: TripProposal[]; refresh: { trip_id: string; proposal: TripProposal }[] } {
	const create: TripProposal[] = [];
	const refresh: { trip_id: string; proposal: TripProposal }[] = [];
	for (const p of proposals) {
		const overlap = existing.find((t) => t.start_date <= p.end_date && p.start_date <= t.end_date);
		if (!overlap) create.push(p);
		else if (overlap.status === "proposed") refresh.push({ trip_id: overlap.id, proposal: p });
	}
	return { create, refresh };
}

export const TRIP_TRANSITIONS: Readonly<Record<TripStatus, readonly TripStatus[]>> = {
	proposed: ["confirmed", "dismissed"],
	confirmed: ["confirmed"],
	dismissed: ["proposed"],
};

export function canMoveTrip(from: TripStatus, to: TripStatus): boolean {
	return TRIP_TRANSITIONS[from].includes(to);
}
