/// The JSON the page and the connector read. One builder per
/// shape, so the page and the connector can never describe the same line two
/// different ways. CONTRACT.md §5 documents each field.
///
/// Every response envelope says ok:true explicitly — a lesson from an earlier project: a
/// worker crash served as JSON has ok === undefined, and a reader that only
/// checks `ok === false` would draw it as an empty month.

import { formatMoney, money, type Money } from "./money";
import { creditNote, creditText } from "./wallet";
import { billCheckMessage, billMoney, type BillDetail } from "./bills";
import { statementAccountId, type ReconResult } from "./reconcile";
import { reimbursable, type ReimbursableView, type ReimburseRange } from "./reimbursable";
import { isSpending } from "./transfers";
import type { Account, BillStatus, EvidenceType, LineRow, HomeStatus, Statement } from "./types";
import { homeCurrency, homeMoney } from "./home";

export type LineFlag = "missed_by_alerts" | "not_on_statement" | "unlinked_refund" | "no_rate" | "needs_review";

export interface LineView {
	id: string;
	date: string;
	account: { id: string; name: string; kind: Account["kind"]; institution: string };
	kind: LineRow["kind"];
	state: LineRow["state"];
	spending: boolean;
	/// No statement has confirmed it yet, and one will (alert / tap only).
	provisional: boolean;
	merchant: { name: string | null; raw: string | null; country: string | null };
	category: string | null;
	amount: {
		original: Money;
		billed: Money & { status: BillStatus };
		home: Money & { status: HomeStatus; set_by: "rules" | "owner" };
		overseas_fee: Money | null; // already inside billed; shown for transparency
	};
	fx: null | {
		market_rate: number | null;
		markup: number | null;
		markup_source: LineRow["markup_source"];
		effective_rate: number | null;
		observed_markup: number | null;
	};
	flags: LineFlag[];
	evidence: EvidenceType[];
	refund_of: string | null;
	/// What the owner said this incoming payment offsets (null = not set).
	income_offset: { to: "salary" | "card" | "line"; account_id: string | null } | null;
	/// Round 2 (B): this line's merchant as a subscription — its row's id,
	/// cadence and status as the owner sees it (ignored = he said it is not one);
	/// null when there is none. Filled by lineViews.
	subscription?: { id: string; cadence: SubscriptionRow["cadence"]; status: SubscriptionView["status"] } | null;
	transfer_group: string | null;
	statement_id: string | null;
	trip_id: string | null;
	reimbursable: ReimbursableView;
	note: string | null;
	/// A wallet (GrabPay) line paid with balance already counted as spending at
	/// top-up: how much of it, the offset line that keeps it from counting twice,
	/// and the owner's words for it. On the offset line itself: the purchase it
	/// offsets. null on every other line. Filled by lineViews.
	wallet?: { precounted: Money; offset_line_id: string | null; offset_of: string | null; message: string } | null;
	/// A prepaid-card purchase paid with bonus credit (19 Oct 2026): the credit
	/// the shop deducted (`used`, the card's own unit — amount.original/billed hold
	/// it too) and what it really cost (= amount.home). null when the two are equal.
	credit?: { used: string; cost: Money; message: string } | null;
	/// A top-up of a prepaid wallet (19 Oct 2026), on BOTH legs of the pair: the
	/// money that left the source account (`paid`, SGD) and the credit the wallet
	/// got. The page shows the pair as ONE line in its lists — the source leg,
	/// titled `title` — and folds the wallet leg (`role` "wallet") into it when
	/// both are listed; the detail shows both. Data unchanged: both legs stay
	/// transfers, never spending. null on every other line. Filled by lineViews.
	topup?: {
		role: "source" | "wallet";
		wallet: { id: string; name: string };
		from: { id: string; name: string } | null;
		source_line_id: string | null;
		wallet_line_id: string;
		paid: Money;
		credit: string;
		title: string;
		message: string;
	} | null;
}

export function lineView(
	line: LineRow,
	account: Account,
	evidence: ReadonlySet<EvidenceType>,
	ranges: readonly ReimburseRange[],
	tripId: string | null,
): LineView {
	const flags: LineFlag[] = [];
	if (line.flag_missed_by_alerts) flags.push("missed_by_alerts");
	if (line.flag_not_on_statement) flags.push("not_on_statement");
	if (line.flag_unlinked_refund) flags.push("unlinked_refund");
	if (line.flag_no_rate) flags.push("no_rate");
	if (line.state === "review") flags.push("needs_review");
	const foreign = line.orig_currency !== line.bill_currency;
	return {
		id: line.id,
		date: line.txn_date,
		account: { id: account.id, name: account.name, kind: account.kind, institution: account.institution },
		kind: line.kind,
		state: line.state,
		spending: isSpending(line),
		provisional: line.statement_id === null && statementAccountId(account) !== null && line.state !== "void" && line.kind !== "wallet_offset",
		merchant: { name: line.merchant_name, raw: line.merchant_raw, country: line.merchant_country },
		category: line.category,
		amount: {
			original: money(line.orig_minor, line.orig_currency),
			billed: { ...money(line.bill_minor, line.bill_currency), status: line.bill_status },
			home: { ...homeMoney(line.home_minor), status: line.home_status, set_by: line.home_set_by },
			overseas_fee: line.fee_minor ? money(line.fee_minor, line.bill_currency) : null,
		},
		fx: foreign
			? { market_rate: line.market_rate, markup: line.markup, markup_source: line.markup_source, effective_rate: line.effective_rate, observed_markup: line.observed_markup }
			: null,
		flags,
		evidence: [...evidence].sort(),
		refund_of: line.refund_of,
		income_offset: line.income_offset ? { to: line.income_offset, account_id: line.offset_account_id ?? null } : null,
		transfer_group: line.transfer_group,
		statement_id: line.statement_id,
		trip_id: tripId,
		reimbursable: reimbursable(line, ranges),
		note: line.note,
		credit:
			account.kind === "wallet" && (line.kind === "purchase" || line.kind === "fee") && line.bill_currency === homeCurrency() && line.home_minor !== line.bill_minor
				? { used: creditText(line.bill_minor), cost: homeMoney(line.home_minor), message: creditNote(creditText(line.bill_minor), formatMoney(line.home_minor, homeCurrency())) }
				: null,
	};
}

export interface Totals {
	spending_home: Money; // purchases + fees − refunds, in SGD
	count: number;
	/// How much of spending_home is still an estimate or a reference figure.
	unconfirmed_home: Money;
	missing_rate_count: number;
}

export function totals(lines: readonly LineRow[]): Totals {
	const spend = lines.filter(isSpending);
	const sum = (ls: readonly LineRow[]) => ls.reduce((s, l) => s + l.home_minor, 0);
	return {
		spending_home: homeMoney(sum(spend)),
		count: spend.length,
		unconfirmed_home: homeMoney(sum(spend.filter((l) => l.home_status === "estimate" || l.home_status === "reference"))),
		missing_rate_count: lines.filter((l) => l.flag_no_rate === 1).length,
	};
}

export interface MonthView {
	statement_id: string;
	account_id: string;
	period_start: string;
	period_end: string;
	status: Statement["recon_status"];
	checked_at: string | null;
	expected: Money | null;
	ledger: Money;
	difference: Money | null;
	problems: ReconResult["problems"];
	/// Round 2 (D): the bill check of the bill this statement carries ("ok" |
	/// "mismatch" | null = not checked / not the bill's piece), its working, and
	/// whether the owner already looked (a reviewed statement leaves 待確認).
	bill_check: "ok" | "mismatch" | null;
	bill: Record<string, Money> | null;
	reviewed_at: string | null;
}

export function monthView(s: Statement): MonthView {
	const r = s.recon_detail_json ? (JSON.parse(s.recon_detail_json) as ReconResult) : null;
	const bill = s.bill_detail_json ? (JSON.parse(s.bill_detail_json) as BillDetail) : null;
	return {
		statement_id: s.id,
		account_id: s.account_id,
		period_start: s.period_start,
		period_end: s.period_end,
		status: s.recon_status,
		checked_at: s.recon_checked_at,
		expected: r?.expected_minor === null || r === null ? null : money(r.expected_minor, s.currency),
		ledger: money(r?.ledger_minor ?? 0, s.currency),
		difference: r?.difference_minor === null || r === null ? null : money(r.difference_minor, s.currency),
		problems: [...(r?.problems ?? []), ...(s.bill_check === "mismatch" && bill ? [{ code: "bill_mismatch" as const, message: billCheckMessage(bill) }] : [])],
		bill_check: s.bill_check ?? null,
		bill: billMoney(bill),
		reviewed_at: s.reviewed_at ?? null,
	};
}

// ------------------------------------------------------------ the envelope

/// Every response from the page's API and every connector tool. `ok: true`
/// is load-bearing: a reader must require it, never infer success from the
/// absence of `ok: false`.
export type Envelope<T extends object> = ({ ok: true } & T) | { ok: false; message: string };

// ------------------------------------------------------------- trips

export interface TripRow {
	id: string;
	name: string | null;
	destination: string;
	countries_json: string;
	start_date: string;
	end_date: string;
	status: "proposed" | "confirmed" | "dismissed";
	evidence_ids_json: string;
	confirmed_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface TripView {
	id: string;
	name: string | null;
	destination: string;
	countries: string[];
	start_date: string;
	end_date: string;
	status: TripRow["status"];
	total_home: Money; // the true cost: overseas fees are inside each purchase
	unconfirmed_home: Money; // the part still estimated
	line_count: number;
	reimbursable_home: Money;
}

export function tripView(trip: TripRow, members: readonly LineRow[], ranges: readonly ReimburseRange[]): TripView {
	const t = totals(members);
	return {
		id: trip.id,
		name: trip.name,
		destination: trip.destination,
		countries: JSON.parse(trip.countries_json) as string[],
		start_date: trip.start_date,
		end_date: trip.end_date,
		status: trip.status,
		total_home: homeMoney(members.reduce((s, l) => s + l.home_minor, 0)),
		unconfirmed_home: t.unconfirmed_home,
		line_count: members.length,
		reimbursable_home: homeMoney(members.filter((l) => reimbursable(l, ranges).effective).reduce((s, l) => s + l.home_minor, 0)),
	};
}

// ------------------------------------------------------------- subscriptions

export interface SubscriptionRow {
	id: string;
	merchant_key: string;
	merchant_name: string | null;
	currency: string;
	cadence: "weekly" | "monthly" | "quarterly" | "yearly";
	amount_minor: number;
	previous_amount_minor: number | null;
	price_changed_on: string | null;
	first_seen: string;
	last_charged: string;
	next_renewal: string;
	occurrences: number;
	status: "active" | "lapsed";
	owner_status: "ignored" | "cancelled" | "active" | null;
	line_ids_json: string;
	updated_at: string;
	/// migration 0005: 'owner' = he marked it from a line in 明細.
	marked_by?: "owner" | null;
}

export interface SubscriptionView {
	id: string;
	merchant: string;
	cadence: SubscriptionRow["cadence"];
	amount: Money;
	previous_amount: Money | null;
	price_changed_on: string | null;
	last_charged: string;
	next_renewal: string;
	occurrences: number;
	/// The owner's word first, then what detection saw: active 訂閱中, lapsed
	/// 可能已停止 (detection only), cancelled 已取消, ignored (hidden; 已移除的項目).
	status: "active" | "lapsed" | "ignored" | "cancelled";
	/// Who decided the status: "owner" (his word) or "detection".
	status_by: "owner" | "detection";
	/// "owner" = he marked it as a subscription himself from a line.
	marked_by: "owner" | null;
	monthly_equivalent: Money;
}

const PER_MONTH = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 } as const;

export function subscriptionView(s: SubscriptionRow): SubscriptionView {
	return {
		id: s.id,
		merchant: s.merchant_name ?? s.merchant_key,
		cadence: s.cadence,
		amount: money(s.amount_minor, s.currency),
		previous_amount: s.previous_amount_minor === null ? null : money(s.previous_amount_minor, s.currency),
		price_changed_on: s.price_changed_on,
		last_charged: s.last_charged,
		next_renewal: s.next_renewal,
		occurrences: s.occurrences,
		status: s.owner_status ?? s.status,
		status_by: s.owner_status ? "owner" : "detection",
		marked_by: s.marked_by === "owner" ? "owner" : null,
		monthly_equivalent: money(Math.round(s.amount_minor * PER_MONTH[s.cadence]), s.currency),
	};
}

// ------------------------------------------------------------- weekly email

/// What the worker's weekly cron puts in the summary email. The email
/// carries SUMMARY_HEADER and SUMMARY_MARKER (src/dedup.ts) so the ledger
/// never reads it back as evidence.
export interface WeeklySummary {
	week_start: string; // Monday, on the owner's calendar
	week_end: string;
	spending_home: Money;
	unconfirmed_home: Money;
	by_category: { category: string; spending_home: Money }[];
	largest: LineView[]; // up to 5
	new_subscriptions: SubscriptionView[];
	price_changes: SubscriptionView[];
	renewals_next_7_days: SubscriptionView[];
	needs_owner: { kind: string; message: string }[]; // trips to confirm, unknown Wallet cards, months that failed
	coverage: { account: string; message: string; partial: boolean }[];
}
