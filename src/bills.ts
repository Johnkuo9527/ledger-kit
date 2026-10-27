/// The bill check (round 2, meeting point D): does a card bill add up
/// to the cent, the way the owner pays it?
///
///   previous balance − payments + purchases − refunds + fees/interest = statement balance
///
/// Everything in the card's currency, minor units, a balance he owes +. The
/// lines are the bill's PRINTED lines (statement_line evidence) — for a bill
/// covering several cards (台新) the lines of every piece of the bill. A line
/// is a payment when the reader said so ("payment") or the ledger filed it as
/// a card bill payment; a fee when it is a fee / overseas fee / interest
/// line; otherwise a purchase (+) or a refund (−). The payments figure is the
/// one the bill prints, else the sum of its payment lines.

import { money, type Money } from "./money";
import { say } from "./words";

export interface BillLine {
	currency: string;
	amount_minor: number;
	bill_minor: number | null;
	kind_hint: string | null;
	line_kind: string | null;
}

export interface BillFigures {
	currency: string;
	previous_balance_minor: number | null;
	statement_balance_minor: number | null;
	payments_credited_minor: number | null;
}

export interface BillDetail {
	currency: string;
	previous_minor: number;
	payments_minor: number; // what the equation used (printed, else the payment lines)
	payments_printed_minor: number | null;
	payment_lines_minor: number;
	purchases_minor: number;
	refunds_minor: number; // as a positive figure
	fees_minor: number;
	computed_minor: number;
	statement_balance_minor: number;
	difference_minor: number; // computed − statement balance
	line_count: number;
}

export interface BillCheck {
	status: "ok" | "mismatch" | null; // null = cannot be checked (figures missing)
	detail: BillDetail | null;
	why: string | null; // when null: why it could not be checked
}

const FEE_HINTS: ReadonlySet<string> = new Set(["fee", "fx_fee", "interest"]);

export function billCheck(bill: BillFigures, lines: readonly BillLine[]): BillCheck {
	const { previous_balance_minor: prev, statement_balance_minor: balance } = bill;
	if (prev === null || balance === null) return { status: null, detail: null, why: "the bill's previous or new balance was not read" };
	let payments = 0;
	let purchases = 0;
	let refunds = 0;
	let fees = 0;
	for (const l of lines) {
		const amount = l.currency === bill.currency ? l.amount_minor : l.bill_minor;
		if (amount === null) return { status: null, detail: null, why: "a foreign line on the bill has no amount in the card's currency" };
		if (l.kind_hint === "payment" || l.line_kind === "card_payment") payments -= amount;
		else if ((l.kind_hint && FEE_HINTS.has(l.kind_hint)) || l.line_kind === "fee") fees += amount;
		else if (amount >= 0) purchases += amount;
		else refunds -= amount;
	}
	const used = bill.payments_credited_minor ?? payments;
	const computed = prev - used + purchases - refunds + fees;
	return {
		status: computed === balance ? "ok" : "mismatch",
		why: null,
		detail: {
			currency: bill.currency,
			previous_minor: prev,
			payments_minor: used,
			payments_printed_minor: bill.payments_credited_minor,
			payment_lines_minor: payments,
			purchases_minor: purchases,
			refunds_minor: refunds,
			fees_minor: fees,
			computed_minor: computed,
			statement_balance_minor: balance,
			difference_minor: computed - balance,
			line_count: lines.length,
		},
	};
}

/// The bill check as the owner reads it (his language, the bill's currency).
export function billCheckMessage(d: BillDetail): string {
	const f = (m: number) => money(m, d.currency).display;
	return say("bill.check_off", { previous: f(d.previous_minor), paid: f(d.payments_minor), purchases: f(d.purchases_minor), refunds: f(d.refunds_minor), fees: f(d.fees_minor), computed: f(d.computed_minor), printed: f(d.statement_balance_minor), difference: f(d.difference_minor) });
}

export function billMoney(d: BillDetail | null): Record<string, Money> | null {
	if (!d) return null;
	return {
		previous_balance: money(d.previous_minor, d.currency),
		payments: money(d.payments_minor, d.currency),
		purchases: money(d.purchases_minor, d.currency),
		refunds: money(d.refunds_minor, d.currency),
		fees: money(d.fees_minor, d.currency),
		computed: money(d.computed_minor, d.currency),
		statement_balance: money(d.statement_balance_minor, d.currency),
		difference: money(d.difference_minor, d.currency),
	};
}
