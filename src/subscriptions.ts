/// Subscriptions: the same merchant charging on a steady rhythm.
///
///   1. Group purchases by merchant + currency.
///   2. Within a group, find a run of SAME-AMOUNT charges on a steady cadence
///      (weekly / monthly / quarterly / yearly), long enough to be a pattern
///      (CADENCES[].min). That run is the seed.
///   3. Extend the seed forwards and backwards along the cadence, accepting a
///      charge at a DIFFERENT amount when it lands on the expected date — that
///      is a price change, and the most recent one is reported.
///   4. Next renewal = one cadence step after the last charge. Past due by more
///      than the tolerance → 'lapsed' (probably cancelled).
/// The owner's word (subscriptions.owner_status) always beats detection.

import { addDays, addMonths, daysBetween } from "./dates";
import type { LineRow } from "./types";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

interface CadenceRule {
	cadence: Cadence;
	tolerance_days: number;
	min: number; // same-amount charges needed to call it a pattern
	step: (date: string, k: number, anchorDay: number) => string;
}

export const CADENCES: readonly CadenceRule[] = [
	{ cadence: "weekly", tolerance_days: 2, min: 4, step: (d, k) => addDays(d, 7 * k) },
	{ cadence: "monthly", tolerance_days: 4, min: 3, step: (d, k, a) => addMonths(d, k, a) },
	{ cadence: "quarterly", tolerance_days: 7, min: 3, step: (d, k, a) => addMonths(d, 3 * k, a) },
	{ cadence: "yearly", tolerance_days: 10, min: 2, step: (d, k, a) => addMonths(d, 12 * k, a) },
];

export type SubLine = Pick<LineRow, "id" | "kind" | "state" | "txn_date" | "merchant_key" | "merchant_name" | "orig_currency" | "orig_minor">;

export interface DetectedSubscription {
	merchant_key: string;
	merchant_name: string | null;
	currency: string;
	cadence: Cadence;
	amount_minor: number; // the latest price
	previous_amount_minor: number | null; // the price before the latest change
	price_changed_on: string | null; // first charge at the latest price
	first_seen: string;
	last_charged: string;
	next_renewal: string;
	occurrences: number;
	status: "active" | "lapsed";
	line_ids: string[];
}

function dayOf(date: string): number {
	return Number(date.slice(8, 10));
}

/// The longest same-amount chain on this cadence starting anywhere in `items`.
function longestChain(items: readonly SubLine[], rule: CadenceRule): SubLine[] {
	let best: SubLine[] = [];
	for (let i = 0; i < items.length; i++) {
		const chain = [items[i]!];
		const anchor = dayOf(items[i]!.txn_date);
		for (let j = i + 1; j < items.length; j++) {
			const last = chain[chain.length - 1]!;
			const expected = rule.step(last.txn_date, 1, anchor);
			const off = daysBetween(expected, items[j]!.txn_date);
			if (Math.abs(off) <= rule.tolerance_days) chain.push(items[j]!);
			else if (off > rule.tolerance_days) break; // a gap: the chain ends
			// else: an extra charge before the due date — skip it
		}
		if (chain.length > best.length) best = chain;
	}
	return best;
}

/// The charge in `pool` landing on `expected`: same amount preferred, then the
/// nearest date.
function chargeNear(pool: readonly SubLine[], expected: string, rule: CadenceRule, amount: number, used: ReadonlySet<string>): SubLine | null {
	const near = pool
		.filter((l) => !used.has(l.id) && Math.abs(daysBetween(expected, l.txn_date)) <= rule.tolerance_days)
		.sort(
			(a, b) =>
				Number(b.orig_minor === amount) - Number(a.orig_minor === amount) ||
				Math.abs(daysBetween(expected, a.txn_date)) - Math.abs(daysBetween(expected, b.txn_date)) ||
				a.id.localeCompare(b.id),
		);
	return near[0] ?? null;
}

/// A series that stops exactly where another (same merchant, same cadence)
/// starts is ONE subscription whose price changed — when both prices ran long
/// enough to be series of their own.
function joinPriceChanges(chains: SubLine[][], rule: CadenceRule): SubLine[][] {
	const sorted = [...chains].sort((a, b) => a[0]!.txn_date.localeCompare(b[0]!.txn_date));
	const out: SubLine[][] = [];
	for (const chain of sorted) {
		const host = out.find((prev) => {
			const last = prev[prev.length - 1]!;
			const due = rule.step(last.txn_date, 1, dayOf(prev[0]!.txn_date));
			return last.txn_date < chain[0]!.txn_date && Math.abs(daysBetween(due, chain[0]!.txn_date)) <= rule.tolerance_days;
		});
		if (host) host.push(...chain);
		else out.push([...chain]);
	}
	return out;
}

function describe(chain: SubLine[], rule: CadenceRule, today: string): DetectedSubscription {
	const anchor = dayOf(chain[0]!.txn_date);
	const last = chain[chain.length - 1]!;
	let changeAt = chain.length - 1;
	while (changeAt > 0 && chain[changeAt - 1]!.orig_minor === last.orig_minor) changeAt--;
	const changed = changeAt > 0;
	const nextRenewal = rule.step(last.txn_date, 1, anchor);
	return {
		merchant_key: last.merchant_key!,
		merchant_name: last.merchant_name,
		currency: last.orig_currency,
		cadence: rule.cadence,
		amount_minor: last.orig_minor,
		previous_amount_minor: changed ? chain[changeAt - 1]!.orig_minor : null,
		price_changed_on: changed ? chain[changeAt]!.txn_date : null,
		first_seen: chain[0]!.txn_date,
		last_charged: last.txn_date,
		next_renewal: nextRenewal,
		occurrences: chain.length,
		status: daysBetween(nextRenewal, today) > rule.tolerance_days ? "lapsed" : "active",
		line_ids: chain.map((l) => l.id),
	};
}

export function detectSubscriptions(lines: readonly SubLine[], today: string): DetectedSubscription[] {
	const groups = new Map<string, SubLine[]>();
	for (const l of lines) {
		if (l.kind !== "purchase" || l.state === "void" || !l.merchant_key || l.orig_minor <= 0) continue;
		const key = `${l.merchant_key}\u0000${l.orig_currency}`;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(l);
	}

	const found: DetectedSubscription[] = [];
	for (const group of groups.values()) {
		group.sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
		const used = new Set<string>();
		const byAmount = new Map<number, SubLine[]>();
		for (const l of group) (byAmount.get(l.orig_minor) ?? byAmount.set(l.orig_minor, []).get(l.orig_minor)!).push(l);

		for (const rule of CADENCES) {
			// Every same-price series first, all reserved before any is extended:
			// Apple bills iCloud and Music under one name, and extending one
			// series must never swallow the other's charges as a "price change".
			const chains: SubLine[][] = [];
			for (const cluster of byAmount.values()) {
				const seed = longestChain(
					cluster.filter((l) => !used.has(l.id)),
					rule,
				);
				if (seed.length < rule.min) continue;
				seed.forEach((l) => used.add(l.id));
				chains.push(seed);
			}
			for (const chain of chains) {
				const anchor = dayOf(chain[0]!.txn_date);
				// Forwards: a different amount on the due date is a price change.
				for (;;) {
					const last = chain[chain.length - 1]!;
					const next = chargeNear(group, rule.step(last.txn_date, 1, anchor), rule, last.orig_minor, used);
					if (!next || next.txn_date <= last.txn_date) break;
					used.add(next.id);
					chain.push(next);
				}
				// Backwards: the older prices.
				for (;;) {
					const first = chain[0]!;
					const prev = chargeNear(group, rule.step(first.txn_date, -1, anchor), rule, first.orig_minor, used);
					if (!prev || prev.txn_date >= first.txn_date) break;
					used.add(prev.id);
					chain.unshift(prev);
				}
			}
			for (const chain of joinPriceChanges(chains, rule)) found.push(describe(chain, rule, today));
		}
	}
	return found.sort((a, b) => a.merchant_key.localeCompare(b.merchant_key) || a.cadence.localeCompare(b.cadence));
}

/// Monthly-equivalent cost, for "what do my subscriptions cost a month".
export function monthlyEquivalent(sub: Pick<DetectedSubscription, "cadence" | "amount_minor">): number {
	const perMonth = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[sub.cadence];
	return Math.round(sub.amount_minor * perMonth);
}

export const SUBSCRIPTION_CADENCES: readonly Cadence[] = ["weekly", "monthly", "quarterly", "yearly"];

/// A subscription the owner marked himself (round 2, meeting point B): HE decides
/// it is one, at his cadence; detection only keeps its figures current — from
/// ALL that merchant's charges in that currency (`lines`, any order), not just
/// a steady same-amount run. The latest charge sets the price and the next
/// renewal; past due by more than the cadence's tolerance reads 'lapsed'
/// (shown as 可能已停止, until he says 'active'). null = no charge to go on.
export function ownerSubscription(lines: readonly SubLine[], cadence: Cadence, today: string): DetectedSubscription | null {
	const rule = CADENCES.find((r) => r.cadence === cadence)!;
	const charges = lines
		.filter((l) => l.kind === "purchase" && l.state !== "void" && l.merchant_key && l.orig_minor > 0)
		.sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
	if (!charges.length) return null;
	return describe(charges, rule, today);
}
