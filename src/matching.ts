/// One purchase = one ledger line. The bank alert, the merchant's receipt and
/// the statement line for it are EVIDENCE attached to that one line.
///
/// A piece of evidence matches a line when ALL of these hold:
///   * same account — or an account that settles into it (a DBS debit-card
///     purchase appears on the DBS bank statement). Receipts name no account,
///     so they may match any;
///   * the same kind (a refund never matches a purchase);
///   * the line has no evidence of this type yet (one alert, one receipt, one
///     statement line per purchase);
///   * dates within MATCH_WINDOW_DAYS;
///   * the amount: exactly, in the merchant's currency — or, for a statement
///     that prints only the billed amount of a foreign charge, within
///     FX_TOLERANCE of the estimate.
/// Among the lines that pass, the most similar merchant wins, then the closest
/// date, then the oldest line (so two identical $4.50 coffees pair up in order).

import { homeCountry, homeCurrency } from "./home";
import { kindsMatch } from "./payees";
import { daysBetween } from "./dates";
import { merchantSimilarity } from "./merchant";
import type { EvidenceType, LineKind, LineRow } from "./types";

export const MATCH_WINDOW_DAYS = 3;
/// A foreign estimate and its billed amount differ by the markup error, a few
/// percent at most. 4% covers a default markup that turned out wrong.
export const FX_TOLERANCE = 0.04;
/// Below this, two merchant names are treated as unrelated.
export const STRONG_MERCHANT = 0.5;

export interface MatchInput {
	type: EvidenceType;
	/// Accounts this evidence may belong to; null = unknown (a receipt).
	account_ids: ReadonlySet<string> | null;
	kind: LineKind;
	currency: string;
	amount_minor: number;
	txn_date: string;
	merchant_key: string;
}

export interface Candidate {
	line: LineRow;
	/// Evidence types already attached to the line.
	has: ReadonlySet<EvidenceType>;
}

export type MatchVia = "exact" | "tolerance";

export type MatchDecision =
	| { action: "attach"; line_id: string; via: MatchVia; merchant_score: number }
	| { action: "create" } // no line yet: this evidence starts one
	| { action: "hold"; reason: string } // receipts never start a line; retried later
	| { action: "review"; candidate_ids: string[]; reason: string };

interface Fit {
	line: LineRow;
	via: MatchVia;
	merchant: number;
	days: number;
}

function amountFits(input: MatchInput, line: LineRow): MatchVia | null {
	if (input.currency === line.orig_currency && input.amount_minor === line.orig_minor) return "exact";
	// Statement printing only the billed figure of a foreign charge.
	if (
		input.type === "statement_line" &&
		input.currency === line.bill_currency &&
		line.orig_currency !== line.bill_currency &&
		line.bill_status === "estimate" &&
		Math.sign(input.amount_minor) === Math.sign(line.bill_minor) &&
		Math.abs(input.amount_minor - line.bill_minor) <= Math.abs(line.bill_minor) * FX_TOLERANCE
	) {
		return "tolerance";
	}
	return null;
}

export function candidateFits(input: MatchInput, candidates: readonly Candidate[], anyKind = false): Fit[] {
	const fits: Fit[] = [];
	for (const { line, has } of candidates) {
		if (line.state === "void") continue;
		// A wallet's offset line is the ledger's own counter-entry, never a purchase.
		if (line.kind === "wallet_offset") continue;
		if (input.account_ids && !input.account_ids.has(line.account_id)) continue;
		if (!anyKind && !kindsMatch(line.kind, input.kind)) continue;
		if (has.has(input.type)) continue;
		const days = Math.abs(daysBetween(line.txn_date, input.txn_date));
		if (days > MATCH_WINDOW_DAYS) continue;
		const via = amountFits(input, line);
		if (!via) continue;
		fits.push({ line, via, merchant: merchantSimilarity(input.merchant_key, line.merchant_key ?? ""), days });
	}
	fits.sort(
		(a, b) =>
			b.merchant - a.merchant ||
			a.days - b.days ||
			Number(a.via === "tolerance") - Number(b.via === "tolerance") ||
			a.line.created_at.localeCompare(b.line.created_at) ||
			a.line.id.localeCompare(b.line.id),
	);
	return fits;
}

/// Two lines that would look identical to the owner: same merchant, same amount.
/// Choosing either is correct, so it is not a reason to ask.
function interchangeable(a: LineRow, b: LineRow): boolean {
	return a.merchant_key === b.merchant_key && a.orig_currency === b.orig_currency && a.orig_minor === b.orig_minor;
}

export function matchEvidence(input: MatchInput, candidates: readonly Candidate[]): MatchDecision {
	const fits = candidateFits(input, candidates);
	const attach = (f: Fit): MatchDecision => ({ action: "attach", line_id: f.line.id, via: f.via, merchant_score: f.merchant });
	const best = fits[0];

	if (input.type === "receipt") {
		// A receipt alone never makes a line: order confirmations for things paid
		// elsewhere, invoices not yet paid, cancelled orders. It waits for the
		// alert or the statement line, and attaches then.
		if (!best) return { action: "hold", reason: "no matching payment yet" };
		if (best.merchant >= STRONG_MERCHANT) return attach(best);
		if (fits.length === 1 && best.via === "exact" && best.days <= 1) return attach(best);
		return { action: "hold", reason: "amount and date fit, but the merchant does not" };
	}

	if (!best) {
		// Same account, same signed amount, same days — but sorted into another
		// kind (the alert said "transfer", the statement "purchase"). Creating a
		// second line would count it twice; hold it for a look instead.
		const otherKind = candidateFits(input, candidates, true);
		if (otherKind.length) {
			return { action: "review", candidate_ids: otherKind.map((f) => f.line.id), reason: "same amount and date as a line of a different kind" };
		}
		return { action: "create" };
	}
	if (best.merchant >= STRONG_MERCHANT) return attach(best);
	// Account, kind, amount and date all agree; only the merchant text differs
	// (bank descriptors are terse). One candidate, or several that are the same
	// purchase to the eye, is safe to take.
	if (fits.every((f) => interchangeable(f.line, best.line))) return attach(best);
	return {
		action: "review",
		candidate_ids: fits.map((f) => f.line.id),
		reason: "several purchases fit and the merchant name does not pick one",
	};
}

// ------------------------------------------------- overseas-fee statement lines

/// The country a card in this currency is at home in: the owner's own home
/// country for the home currency, else the one country a currency belongs to.
/// A currency shared by many countries (EUR on a foreign card) has none: only a
/// currency difference makes its charges foreign.
const CURRENCY_COUNTRY: Readonly<Record<string, string>> = { SGD: "SG", TWD: "TW", JPY: "JP", GBP: "GB", USD: "US", AUD: "AU", HKD: "HK", MYR: "MY", THB: "TH", KRW: "KR", CNY: "CN", CAD: "CA", NZD: "NZ", CHF: "CH", INR: "IN", IDR: "ID", PHP: "PH", VND: "VN" };

/// A charge that attracts an overseas fee: charged in another currency, or by
/// a merchant outside the account's home country.
export function isForeign(line: Pick<LineRow, "orig_currency" | "bill_currency" | "merchant_country">): boolean {
	if (line.orig_currency !== line.bill_currency) return true;
	const home = line.bill_currency === homeCurrency() ? homeCountry() : CURRENCY_COUNTRY[line.bill_currency];
	return !!line.merchant_country && !!home && line.merchant_country !== home;
}

/// A fee bigger than this share of its purchase is not an overseas fee.
export const MAX_FEE_SHARE = 0.05;

export interface StatementRow {
	seq: number;
	kind_hint: string | null;
	txn_date: string;
	/// The ledger line this statement row was matched to (null for fee rows).
	line: LineRow | null;
}

/// The purchase an itemised overseas-fee line belongs to, so the fee is part
/// of that purchase's true cost (the owner's rule) rather than a separate expense.
///   1. the nearest earlier row on the statement that is a foreign charge,
///      within a day, with a plausible fee size; else
///   2. the only foreign charge on the statement with that date and a plausible
///      fee size; else
///   3. none — the fee stands as its own 'fee' line.
export function feeTarget(fee: { seq: number; txn_date: string; amount_minor: number }, rows: readonly StatementRow[]): string | null {
	const plausible = (line: LineRow) =>
		line.kind === "purchase" &&
		isForeign(line) &&
		fee.amount_minor > 0 &&
		line.bill_minor > 0 &&
		fee.amount_minor <= line.bill_minor * MAX_FEE_SHARE;

	const earlier = rows
		.filter((r) => r.seq < fee.seq && r.kind_hint !== "fx_fee" && r.line)
		.sort((a, b) => b.seq - a.seq);
	const nearest = earlier[0];
	if (nearest?.line && Math.abs(daysBetween(nearest.txn_date, fee.txn_date)) <= 1 && plausible(nearest.line)) {
		return nearest.line.id;
	}
	const sameDay = rows.filter((r) => r.line && r.kind_hint !== "fx_fee" && r.txn_date === fee.txn_date && plausible(r.line));
	const ids = new Set(sameDay.map((r) => r.line!.id));
	return ids.size === 1 ? [...ids][0]! : null;
}
