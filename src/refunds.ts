/// A refund links to the purchase it gives back (lines.refund_of), so a
/// returned order nets to zero on the page and a trip total is not inflated by
/// something that came back.
///
/// The original is: on the same account (refunds go back to the card that
/// paid), a purchase, not void, dated on or before the refund and within
/// REFUND_WINDOW_DAYS, a similar merchant, in the same currency, and not
/// already refunded in full. An exact-amount original beats a partial one;
/// then the most recent.

import { daysBetween } from "./dates";
import { merchantSimilarity } from "./merchant";
import { STRONG_MERCHANT } from "./matching";
import type { LineRow } from "./types";

export const REFUND_WINDOW_DAYS = 180;

export type RefundLike = Pick<LineRow, "id" | "account_id" | "kind" | "txn_date" | "merchant_key" | "orig_currency" | "orig_minor">;

/// `alreadyRefunded` = for each purchase id, the total (positive, minor units in
/// the purchase's currency) of refunds already linked to it.
export function findRefundOriginal(
	refund: RefundLike,
	purchases: readonly LineRow[],
	alreadyRefunded: ReadonlyMap<string, number>,
): LineRow | null {
	if (refund.kind !== "refund") return null;
	const give = Math.abs(refund.orig_minor);
	const fits = purchases.filter((p) => {
		if (p.kind !== "purchase" || p.state === "void" || p.account_id !== refund.account_id) return false;
		if (p.orig_currency !== refund.orig_currency) return false;
		const age = daysBetween(p.txn_date, refund.txn_date);
		if (age < 0 || age > REFUND_WINDOW_DAYS) return false;
		if (merchantSimilarity(p.merchant_key ?? "", refund.merchant_key ?? "") < STRONG_MERCHANT) return false;
		const left = p.orig_minor - (alreadyRefunded.get(p.id) ?? 0);
		return give <= left;
	});
	fits.sort(
		(a, b) =>
			Number(b.orig_minor === give) - Number(a.orig_minor === give) ||
			b.txn_date.localeCompare(a.txn_date) ||
			a.id.localeCompare(b.id),
	);
	return fits[0] ?? null;
}
