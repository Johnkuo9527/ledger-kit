/// The owner's FX rules (binding):
///
/// 1. A foreign charge stores its ORIGINAL currency and amount, and shows an
///    ESTIMATED SGD at once. When the statement posts, the billed amount
///    replaces the estimate, the effective rate (billed ÷ foreign) is recorded,
///    and the status goes estimate → confirmed.
/// 2. estimate = foreign × that day's market rate × (1 + the card's markup),
///    where markup = billed ÷ (foreign × market rate on the transaction date) − 1,
///    learned from the latest confirmed line for that card + currency and
///    updated on every confirmation. No observation yet → the bank's default,
///    and the line says so (markup_source = 'bank_default').
///
/// The overseas fee is part of the purchase: an itemised fee line on a statement
/// is ADDED to the purchase's billed amount before the markup is measured, so
/// the markup — and every trip total — is the true all-in cost.

import { addDays } from "./dates";
import { convertMinor, toMajor } from "./money";
import type { BillStatus, LineKind, MarkupSource, HomeStatus } from "./types";
import { homeCurrency } from "./home";

/// A stored rate: units of `quote` per one unit of `currency` on `date`.
export type RateLookup = (date: string, currency: string, quote: string) => number | undefined;

/// How far back a missing day may borrow a rate (weekends, public holidays).
export const MAX_RATE_AGE_DAYS = 7;

export interface FoundRate {
	rate: number;
	rate_date: string;
}

/// Units of `to` per one unit of `from` on `date`: direct, inverse, or crossed
/// through SGD (the rates table is normally stored as X→SGD). Walks back up to
/// MAX_RATE_AGE_DAYS for a day with no published rate.
export function marketRate(lookup: RateLookup, date: string, from: string, to: string): FoundRate | null {
	if (from === to) return { rate: 1, rate_date: date };
	for (let back = 0; back <= MAX_RATE_AGE_DAYS; back++) {
		const d = addDays(date, -back);
		const rate = rateOn(lookup, d, from, to);
		if (rate !== undefined) return { rate, rate_date: d };
	}
	return null;
}

function rateOn(lookup: RateLookup, d: string, from: string, to: string): number | undefined {
	const direct = lookup(d, from, to);
	if (direct) return direct;
	const inverse = lookup(d, to, from);
	if (inverse) return 1 / inverse;
	const base = homeCurrency();
	const fromHome = from === base ? 1 : lookup(d, from, base);
	const toHome = to === base ? 1 : lookup(d, to, base);
	if (fromHome && toHome) return fromHome / toHome;
	return undefined;
}

export interface LearnedMarkup {
	markup: number;
	observed_txn_date: string;
}

/// The markup an estimate should use for this card + currency.
export function markupFor(
	learned: LearnedMarkup | undefined,
	institution: string,
	defaults: ReadonlyMap<string, number>,
): { markup: number; source: MarkupSource } {
	if (learned) return { markup: learned.markup, source: "learned" };
	const fallback = defaults.get(institution) ?? defaults.get("*");
	if (fallback === undefined) throw new Error(`no default FX markup for ${institution} and no '*' fallback`);
	return { markup: fallback, source: "bank_default" };
}

/// The estimated billed amount, in the account's currency.
export function estimateBill(origMinor: number, origCcy: string, billCcy: string, rate: number, markup: number): number {
	return convertMinor(origMinor, origCcy, billCcy, rate * (1 + markup));
}

export interface Observation {
	effective_rate: number;
	observed_markup: number;
}

/// What a confirmed statement amount says about the card's real markup.
/// billMinor INCLUDES any itemised overseas fee already attached.
export function observe(billMinor: number, origMinor: number, origCcy: string, billCcy: string, rate: number): Observation {
	if (origMinor === 0) throw new RangeError("cannot observe a rate on a zero amount");
	const effective = toMajor(billMinor, billCcy) / toMajor(origMinor, origCcy);
	return { effective_rate: effective, observed_markup: effective / rate - 1 };
}

/// Whether a confirmation should replace the card's learned markup.
///   * Only purchases. A refund is often converted without the fee, so it would
///     teach the card a markup of zero or less.
///   * The newest transaction wins. Daily upkeep confirms in date order anyway;
///     the 2-year backfill may confirm out of order, and an old statement
///     arriving late must not overwrite a newer observation.
///   * An observation outside −5%..+15% is not learned: that is a mis-match
///     (wrong line paired with the statement amount), not a markup.
export const PLAUSIBLE_MARKUP = { min: -0.05, max: 0.15 } as const;

export function shouldLearn(
	kind: LineKind,
	origMinor: number,
	observedMarkup: number,
	txnDate: string,
	current: LearnedMarkup | undefined,
): boolean {
	if (kind !== "purchase" || origMinor <= 0) return false;
	if (observedMarkup < PLAUSIBLE_MARKUP.min || observedMarkup > PLAUSIBLE_MARKUP.max) return false;
	return !current || txnDate >= current.observed_txn_date;
}

export interface HomeView {
	home_minor: number;
	home_status: HomeStatus;
	home_rate: number | null;
}

/// The SGD figure every total uses. An SGD account passes its billed amount
/// and status straight through. Any other account (台新 TWD, foreign cash) is
/// converted at the reference rate and marked 'reference' — an estimate that no
/// statement will confirm, only the owner.
export function homeView(billMinor: number, billCcy: string, billStatus: BillStatus, referenceRate: number | null): HomeView {
	if (billCcy === homeCurrency()) return { home_minor: billMinor, home_status: billStatus, home_rate: null };
	if (referenceRate === null) return { home_minor: 0, home_status: "reference", home_rate: null };
	return { home_minor: convertMinor(billMinor, billCcy, homeCurrency(), referenceRate), home_status: "reference", home_rate: referenceRate };
}
