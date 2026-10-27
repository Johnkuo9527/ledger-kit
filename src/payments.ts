/// 總覽 → 繳款 (round 2, meeting point D): for each credit card, its
/// newest bill, what the owner has paid since, what is still to pay and by when,
/// and what he has charged since the cut-off — plus a total row.
///
/// One card going forward: a lost card's bills count as its replacement's
/// (accounts.replaced_by), and a card whose spending is billed on another
/// card's bill (台新: one bill for every card) is shown on that bill's row
/// (`also_on_this_bill`), not as a row of its own — the row is what he pays.
///
/// Paid since the bill: card bill payments credited to the card after the
/// statement date, and his bank's payments to the card not yet matched to
/// one (a matched pair is counted once, on the card). Card currency
/// throughout; the total row is in SGD, converted at the newest reference
/// rate for a foreign card (then `estimate: true`).
///
/// 逾期 only with evidence (14 Oct 2026, CONTRACT.md §16): a card paid
/// by auto-debit from an account the ledger does not track (台新) is
/// `autopay_pending` after its due date, not overdue — its payment shows only
/// on the next statement. The next statement then checks the bill before it:
/// paid in full, or not (a balance carried, a late fee or interest) — and only
/// then is it a real `overdue`, with a 待確認 item. The owner's 「我已繳款」 marks a
/// bill paid when the ledger cannot see the payment; the next statement still
/// checks it.

import { billMoney, type BillDetail } from "./bills";
import { addMonths, daysBetween } from "./dates";
import type { Db } from "./db";
import type { Engine } from "./engine";
import { convertMinor, money, type Money } from "./money";
import { Refused } from "./refused";
import { AUTO_DEBIT_WORDS, paidCard } from "./transfers";
import type { Account, LineRow, Statement } from "./types";
import { homeCurrency, homeMoney } from "./home";

export type PaymentStatus = "paid" | "due" | "overdue" | "autopay_pending" | "unknown";

/// What the next statement says about the bill before it.
export type PreviousVerdict = "paid" | "unpaid" | "unknown";

/// Words a card statement uses for a late fee or interest: the bill before was not paid in time or in full.
const LATE_WORDS = /LATE|逾期|違約金|滯納|遲繳|延滯|利息|循環信用|INTEREST|FINANCE CHARGE/;

export interface CardPayment {
	account: { id: string; name: string; kind: Account["kind"]; institution: string };
	/// Cards whose spending this same bill carries (台新), and the lost cards it replaced.
	also_on_this_bill: { id: string; name: string }[];
	replaces: string[];
	last_statement: {
		statement_id: string;
		period_from: string;
		period_to: string;
		statement_balance: Money | null;
		minimum_due: Money | null;
		due_date: string | null;
		previous_balance: Money | null;
		payments_credited: Money | null;
	} | null;
	paid_since_statement: Money;
	outstanding: Money;
	due_date: string | null;
	days_left: number | null;
	status: PaymentStatus;
	/// Why it is overdue: no payment seen after the due date (and the card is
	/// not auto-debit), or the next statement shows the bill before was not paid.
	status_reason: "no_payment_seen" | "previous_unpaid" | null;
	/// Who says it is paid: the ledger saw the payment, or the owner said so (「我已繳款」).
	paid_source: "ledger" | "owner" | null;
	/// Paid by auto-debit from an account the ledger does not track: the owner's word
	/// (source "owner") beats what the statements show (source "statement").
	autopay: { on: boolean; source: "owner" | "statement" | null };
	/// The bill before, as the newest statement shows it; null = none.
	previous_bill: {
		statement_id: string;
		period_to: string;
		due_date: string | null;
		statement_balance: Money | null;
		payments_credited: Money | null;
		verdict: PreviousVerdict;
		/// Why the verdict: what the newest statement printed or listed.
		reason: "nothing_owed" | "payments_cover_it" | "balance_carried" | "late_fee_or_interest" | "no_payment_info";
		owner_said_paid: boolean;
		seen_by_owner: boolean;
	} | null;
	unbilled: Money;
	/// The bill check (to the cent), else the month's reconciliation.
	reconciliation: {
		status: "reconciled" | "mismatch" | "escalated" | "pending";
		statement_id: string;
		difference: Money | null;
		bill: Record<string, Money> | null;
	} | null;
}

export interface PaymentsView {
	cards: CardPayment[];
	total: { outstanding_home: Money; minimum_due_home: Money; unbilled_home: Money; estimate: boolean; missing_rate: string[] };
}

type Stmt = Statement;
const UNBILLED_KINDS = new Set(["purchase", "refund", "fee"]);

/// The card a lost card became (follows replaced_by, at most a few steps).
function current(accounts: ReadonlyMap<string, Account>, id: string): string {
	let at = id;
	for (let i = 0; i < 5; i++) {
		const next = accounts.get(at)?.replaced_by;
		if (!next || !accounts.has(next)) break;
		at = next;
	}
	return at;
}

/// The due date when the bill printed none: the card's due day, the first such day after the cut-off.
function dueFromDay(periodEnd: string, dueDay: number | null | undefined): string | null {
	if (!dueDay) return null;
	for (let m = 0; m <= 2; m++) {
		const d = addMonths(`${periodEnd.slice(0, 8)}01`, m, dueDay);
		if (d > periodEnd) return d;
	}
	return null;
}

export async function paymentsView(db: Db, today: string): Promise<PaymentsView> {
	// The cards, their bills and the day's rates travel together; then the bills' payment
	// lines with the lines since (20 Oct 2026): two round trips, not five.
	const [accountRows, statementRows, rateRows] = await Promise.all([
		db.prepare("SELECT * FROM accounts WHERE kind IN ('credit_card', 'bank')").bind().all<Account>(),
		db.prepare("SELECT * FROM statements WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'credit_card') ORDER BY period_end DESC, bill_primary DESC").bind().all<Stmt>(),
		db
			.prepare("SELECT f.currency AS currency, f.rate AS rate FROM fx_rates f WHERE f.quote = ? AND f.date = (SELECT MAX(g.date) FROM fx_rates g WHERE g.currency = f.currency AND g.quote = ? AND g.date <= ?)")
			.bind(homeCurrency(), homeCurrency(), today)
			.all<{ currency: string; rate: number }>(),
	]);
	const accounts = new Map(accountRows.results.map((a) => [a.id, a]));
	const cards = [...accounts.values()].filter((a) => a.kind === "credit_card");
	const cardIds = cards.map((c) => c.id);
	const statements = statementRows.results;
	const byId = new Map(statements.map((s) => [s.id, s]));
	const primaryOf = new Map(statements.filter((s) => s.bill_group && s.bill_primary === 1).map((s) => [s.bill_group!, s]));

	// Each card's newest bill, and whose row it belongs to.
	const rowOf = new Map<string, string>(); // card id → the row (current card) it is shown on
	const billOf = new Map<string, Stmt | null>(); // row card → its newest bill (the piece with the figures)
	for (const c of cards) {
		const cur = current(accounts, c.id);
		const newest = statements.find((s) => s.account_id === c.id) ?? null;
		const bill = newest && newest.bill_group && newest.bill_primary === 0 ? (primaryOf.get(newest.bill_group) ?? newest) : newest;
		const owner = bill ? current(accounts, bill.account_id) : cur;
		rowOf.set(c.id, owner);
		if (bill && (!billOf.get(owner) || billOf.get(owner)!.period_end < bill.period_end)) billOf.set(owner, bill);
	}
	// Rows: every active card (or one that has a bill) that is no other card's row member.
	const rows = cards.filter((c) => rowOf.get(c.id) === c.id && (c.active === 1 || billOf.get(c.id)));
	// The row a card is finally shown on: through rows that are themselves on
	// another row (a lost card → its replacement → the bill it is billed on).
	const finalRow = (id: string): string => {
		let at = rowOf.get(id) ?? current(accounts, id);
		for (let i = 0; i < 5; i++) {
			const next = rowOf.get(at) ?? at;
			if (next === at) break;
			at = next;
		}
		return at;
	};
	const members = (row: string) => cards.filter((c) => finalRow(c.id) === row || finalRow(current(accounts, c.id)) === row).map((c) => c.id);
	// A bill's pieces (台新: one per card) — and any statement of the same row's
	// cards closing the same day (a lost card's bill read before the split).
	const rowCards = new Map<string, Set<string>>();
	const piecesOf = (b: Stmt): Stmt[] => {
		const ids = rowCards.get(finalRow(b.account_id)) ?? new Set([b.account_id]);
		return statements.filter((s) => s.id === b.id || (!!b.bill_group && s.bill_group === b.bill_group) || (ids.has(s.account_id) && s.period_end === b.period_end));
	};
	const primary = (s: Stmt): Stmt => (s.bill_group && s.bill_primary === 0 ? (primaryOf.get(s.bill_group) ?? s) : s);
	// The bill before each row's newest: the newest bill of its cards that closed earlier.
	const previousOf = new Map<string, Stmt>();
	for (const c of rows) rowCards.set(c.id, new Set(members(c.id)));
	for (const c of rows) {
		const b = billOf.get(c.id);
		if (!b) continue;
		const ids = rowCards.get(c.id)!;
		const prev = statements.find((s) => ids.has(s.account_id) && s.period_end < b.period_end);
		if (prev) previousOf.set(c.id, primary(prev));
	}
	// Payment and fee lines printed on the newest and previous bills (one query).
	const printedOn = [...billOf.values(), ...previousOf.values()].filter((b): b is Stmt => !!b).flatMap((b) => piecesOf(b).map((p) => p.id));
	const printedP = printedOn.length
		? db
				.prepare("SELECT statement_id, kind, txn_date, bill_currency, bill_minor, merchant_raw FROM lines WHERE state <> 'void' AND kind IN ('card_payment', 'fee') AND statement_id IN (SELECT value FROM json_each(?))")
				.bind(JSON.stringify(printedOn))
				.all<Pick<LineRow, "statement_id" | "kind" | "txn_date" | "bill_currency" | "bill_minor" | "merchant_raw">>()
				.then((r) => r.results)
		: Promise.resolve([]);
	const printedOnBill = (b: Stmt) => {
		const ids = new Set(piecesOf(b).map((p) => p.id));
		return printed.filter((l) => l.statement_id !== null && ids.has(l.statement_id));
	};
	const autoDebit = (b: Stmt | null | undefined) => (b ? printedOnBill(b).some((l) => l.kind === "card_payment" && l.bill_minor < 0 && AUTO_DEBIT_WORDS.test((l.merchant_raw ?? "").normalize("NFKC").toUpperCase())) : false);
	const paysOn = (b: Stmt | null | undefined) => (b ? printedOnBill(b).some((l) => l.kind === "card_payment" && l.bill_minor < 0) : false);
	const ownerSaid = (b: Stmt, k: "paid_by_owner_at" | "unpaid_seen_at") => piecesOf(b).some((p) => !!p[k]);

	// Lines after each bill's cut-off on its cards (one query for all cards).
	const oldest = [...billOf.values()].filter((b): b is Stmt => !!b).map((b) => b.period_end).sort()[0] ?? "0000-00-00";
	const afterP = db
			.prepare(
				"SELECT id, account_id, kind, state, txn_date, bill_currency, bill_minor, home_minor, home_status, statement_id, transfer_group, counter_account_id, merchant_raw FROM lines " +
					"WHERE state <> 'void' AND (statement_id IS NULL OR txn_date > ?) AND (account_id IN (SELECT value FROM json_each(?)) OR (kind = 'card_payment' AND counter_account_id IN (SELECT value FROM json_each(?))) " +
					"OR (kind = 'card_payment' AND transfer_group IS NULL AND account_id IN (SELECT id FROM accounts WHERE kind = 'bank')))",
			)
			.bind(oldest, JSON.stringify(cardIds), JSON.stringify(cardIds))
			.all<Pick<LineRow, "id" | "account_id" | "kind" | "state" | "txn_date" | "bill_currency" | "bill_minor" | "home_minor" | "home_status" | "statement_id" | "transfer_group" | "counter_account_id" | "merchant_raw">>()
			.then((r) => r.results);
	const [printed, after] = await Promise.all([printedP, afterP]);
	// The card each unpaired bank card bill paid: its counter account, or —
	// the safety net for one filed without it — the one card its descriptor
	// names ("Other bank's card ending 5502").
	const allAccounts = [...accounts.values()];
	const paidTo = new Map(after.filter((l) => l.kind === "card_payment" && l.transfer_group === null && accounts.get(l.account_id)?.kind === "bank").map((l) => [l.id, paidCard(l, allAccounts)?.id ?? null]));
	const rates = new Map(rateRows.results.map((r) => [r.currency, r.rate]));

	let outstandingHome = 0;
	let minimumHome = 0;
	let unbilledHome = 0;
	let estimate = false;
	const missingRate = new Set<string>();
	const toHome = (minor: number, ccy: string): number => {
		if (ccy === homeCurrency()) return minor;
		const rate = rates.get(ccy);
		if (!rate) {
			missingRate.add(ccy);
			return 0;
		}
		estimate = true;
		return convertMinor(minor, ccy, homeCurrency(), rate);
	};

	const out: CardPayment[] = [];
	for (const c of rows) {
		const ids = members(c.id);
		const idSet = new Set(ids);
		const bill = billOf.get(c.id) ?? null;
		const ccy = c.currency;
		const one = bill ? !bill.bill_group || ![...byId.values()].some((s) => s.bill_group === bill.bill_group && s.id !== bill.id) : true;
		const balance = bill ? (bill.statement_balance_minor ?? (one ? bill.closing_balance_minor : null)) : null;
		const previous = bill ? (bill.previous_balance_minor ?? (one ? bill.opening_balance_minor : null)) : null;
		const cut = bill?.period_end ?? null;
		let paid = 0;
		let unbilled = 0;
		for (const l of after) {
			if (cut !== null && l.txn_date <= cut) continue;
			if (l.bill_currency !== ccy) continue;
			const onCard = idSet.has(l.account_id);
			if (onCard && l.kind === "card_payment" && l.bill_minor < 0) paid += -l.bill_minor;
			else if (!onCard && l.kind === "card_payment" && l.transfer_group === null && idSet.has(paidTo.get(l.id) ?? "") && l.bill_minor > 0) paid += l.bill_minor;
			else if (onCard && l.statement_id === null && UNBILLED_KINDS.has(l.kind)) {
				unbilled += l.bill_minor;
				unbilledHome += l.home_minor;
				if (l.home_status === "estimate" || l.home_status === "reference") estimate = true;
			}
		}
		const outstanding = balance === null ? 0 : balance - paid;
		const due = bill ? (bill.due_date ?? dueFromDay(bill.period_end, c.due_day)) : null;
		const daysLeft = due ? daysBetween(today, due) : null;
		// Auto-debit: the owner's word on any of the row's cards (the row's own first), else
		// the newest statement that lists a payment at all shows an auto-debit one.
		const said = [c, ...ids.filter((id) => id !== c.id).map((id) => accounts.get(id)!)].find((a) => a.autopay === 0 || a.autopay === 1);
		const prevBill = previousOf.get(c.id) ?? null;
		const detected = paysOn(bill) ? autoDebit(bill) : autoDebit(prevBill);
		const autopay = said ? { on: said.autopay === 1, source: "owner" as const } : { on: detected, source: detected ? ("statement" as const) : null };
		const prior = bill && prevBill ? judgePrevious(prevBill, bill, printedOnBill(bill), ccy, c.due_day) : null;
		const shortfall = prior?.verdict === "unpaid" ? prior.shortfall : 0;
		const prevLate = prior?.verdict === "unpaid" && (prior.due === null || prior.due < today) && paid < shortfall;
		const ownerPaid = !!bill && ownerSaid(bill, "paid_by_owner_at");
		let status: PaymentStatus;
		let reason: CardPayment["status_reason"] = null;
		let paidSource: CardPayment["paid_source"] = null;
		if (balance === null) status = "unknown";
		else if (outstanding <= 0 && !prevLate) [status, paidSource] = ["paid", "ledger"];
		else if (prevLate) [status, reason] = ["overdue", "previous_unpaid"];
		else if (ownerPaid) [status, paidSource] = ["paid", "owner"];
		else if (daysLeft !== null && daysLeft < 0) [status, reason] = autopay.on ? ["autopay_pending", null] : ["overdue", "no_payment_seen"];
		else status = "due";
		if (status === "due" || status === "overdue") {
			outstandingHome += toHome(outstanding, ccy);
			const min = bill?.minimum_due_minor;
			if (min !== null && min !== undefined) minimumHome += toHome(Math.min(min, outstanding), ccy);
		}
		const detail = bill?.bill_detail_json ? (JSON.parse(bill.bill_detail_json) as BillDetail) : null;
		const recon = bill
			? (() => {
					if (bill.bill_check === "ok" || bill.bill_check === "mismatch")
						return { status: bill.bill_check === "ok" ? ("reconciled" as const) : ("mismatch" as const), statement_id: bill.id, difference: detail ? money(detail.difference_minor, ccy) : null, bill: billMoney(detail) };
					const r = bill.recon_detail_json ? (JSON.parse(bill.recon_detail_json) as { difference_minor: number | null }) : null;
					return { status: bill.recon_status, statement_id: bill.id, difference: r?.difference_minor != null ? money(r.difference_minor, ccy) : null, bill: null };
				})()
			: null;
		const m = (v: number | null | undefined) => (v === null || v === undefined ? null : money(v, ccy));
		const previousBill: CardPayment["previous_bill"] =
			prior && prevBill
				? {
						statement_id: prevBill.id,
						period_to: prevBill.period_end,
						due_date: prior.due,
						statement_balance: m(prior.balance),
						payments_credited: m(prior.credited),
						verdict: prior.verdict,
						reason: prior.reason,
						owner_said_paid: ownerSaid(prevBill, "paid_by_owner_at"),
						seen_by_owner: ownerSaid(prevBill, "unpaid_seen_at"),
					}
				: null;
		out.push({
			account: { id: c.id, name: c.name, kind: c.kind, institution: c.institution },
			also_on_this_bill: ids.filter((id) => id !== c.id && accounts.get(id)?.replaced_by !== c.id).map((id) => ({ id, name: accounts.get(id)!.name })),
			replaces: ids.filter((id) => accounts.get(id)?.replaced_by === c.id),
			last_statement: bill
				? {
						statement_id: bill.id,
						period_from: bill.period_start,
						period_to: bill.period_end,
						statement_balance: m(balance),
						minimum_due: m(bill.minimum_due_minor),
						due_date: bill.due_date ?? null,
						previous_balance: m(previous),
						payments_credited: m(bill.payments_credited_minor),
					}
				: null,
			paid_since_statement: money(paid, ccy),
			outstanding: money(outstanding, ccy),
			due_date: due,
			days_left: daysLeft,
			status,
			status_reason: reason,
			paid_source: paidSource,
			autopay,
			previous_bill: previousBill,
			unbilled: money(unbilled, ccy),
			reconciliation: recon,
		});
	}
	const order: Record<PaymentStatus, number> = { overdue: 0, due: 1, unknown: 2, autopay_pending: 3, paid: 4 };
	out.sort((a, b) => order[a.status] - order[b.status] || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || a.account.name.localeCompare(b.account.name));
	return {
		cards: out,
		total: { outstanding_home: homeMoney(outstandingHome), minimum_due_home: homeMoney(minimumHome), unbilled_home: homeMoney(unbilledHome), estimate, missing_rate: [...missingRate] },
	};
}

/// What the newer bill says about the one before: paid in full (its payments
/// credited cover the old balance, or nothing was owed), not paid (less was
/// credited — a balance carried forward — or a late fee / interest is
/// charged), or unknown (it printed no payments figure and lists no payment).
/// `shortfall` = what the old bill still lacks (for "unpaid").
function judgePrevious(
	prev: Statement,
	bill: Statement,
	onBill: readonly Pick<LineRow, "kind" | "txn_date" | "bill_currency" | "bill_minor" | "merchant_raw">[],
	ccy: string,
	dueDay: number | null | undefined,
): { verdict: PreviousVerdict; reason: NonNullable<CardPayment["previous_bill"]>["reason"]; balance: number | null; credited: number | null; shortfall: number; due: string | null } {
	const balance = prev.statement_balance_minor ?? prev.closing_balance_minor ?? null;
	const due = prev.due_date ?? dueFromDay(prev.period_end, dueDay);
	const payLines = onBill.filter((l) => l.kind === "card_payment" && l.bill_minor < 0 && l.bill_currency === ccy && l.txn_date > prev.period_end);
	const credited = bill.payments_credited_minor ?? (payLines.length ? payLines.reduce((s, l) => s - l.bill_minor, 0) : null);
	const late = onBill.some((l) => l.kind === "fee" && l.bill_minor > 0 && LATE_WORDS.test((l.merchant_raw ?? "").normalize("NFKC").toUpperCase()));
	const out = (verdict: PreviousVerdict, reason: NonNullable<CardPayment["previous_bill"]>["reason"], shortfall = 0) => ({ verdict, reason, balance, credited, shortfall, due });
	if (balance === null) return out("unknown", "no_payment_info");
	if (balance <= 0) return out("paid", "nothing_owed");
	if (credited !== null && credited < balance) return out("unpaid", "balance_carried", balance - credited);
	if (late) return out("unpaid", "late_fee_or_interest", Math.max(0, balance - (credited ?? 0)) || balance);
	if (credited !== null) return out("paid", "payments_cover_it");
	return out("unknown", "no_payment_info");
}

/// The bill row a statement id names: its piece with the figures (台新: the bill's primary piece).
async function billRow(db: Db, statementId: string): Promise<Statement> {
	const st = await db.prepare("SELECT s.* FROM statements s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND a.kind = 'credit_card'").bind(statementId).first<Statement>();
	if (!st) throw new Refused("no such card bill");
	if (!st.bill_group || st.bill_primary === 1) return st;
	return (await db.prepare("SELECT * FROM statements WHERE bill_group = ? AND bill_primary = 1").bind(st.bill_group).first<Statement>()) ?? st;
}

/// The owner's 「我已繳款」 (true) on a card bill the ledger cannot see paid — or
/// taking it back (false). Stored on the bill (every piece of a 台新 bill, so a
/// re-read that moves the figures keeps it). The next statement still checks it.
export async function markBillPaid(e: Engine, statementId: string, paid: boolean): Promise<Statement> {
	const bill = await billRow(e.db, statementId);
	const at = paid ? e.now() : null;
	if (bill.bill_group) await e.db.prepare("UPDATE statements SET paid_by_owner_at = ? WHERE bill_group = ?").bind(at, bill.bill_group).run();
	else await e.db.prepare("UPDATE statements SET paid_by_owner_at = ? WHERE id = ?").bind(at, bill.id).run();
	return { ...bill, paid_by_owner_at: at };
}

/// The owner saw the 待確認 item saying the next statement shows this bill was not paid (「知道了」).
export async function markUnpaidSeen(e: Engine, statementId: string): Promise<void> {
	const bill = await billRow(e.db, statementId);
	if (bill.bill_group) await e.db.prepare("UPDATE statements SET unpaid_seen_at = ? WHERE bill_group = ?").bind(e.now(), bill.bill_group).run();
	else await e.db.prepare("UPDATE statements SET unpaid_seen_at = ? WHERE id = ?").bind(e.now(), bill.id).run();
}

/// The owner's word on how a credit card is paid: true auto-debit, false he pays it
/// himself, null = the ledger decides from the card's statements.
export async function setAutopay(e: Engine, accountId: string, autopay: boolean | null): Promise<void> {
	const a = await e.db.prepare("SELECT kind FROM accounts WHERE id = ?").bind(accountId).first<{ kind: string }>();
	if (!a) throw new Refused("no such account");
	if (a.kind !== "credit_card") throw new Refused("only a credit card can be paid by auto-debit");
	await e.db.prepare("UPDATE accounts SET autopay = ? WHERE id = ?").bind(autopay === null ? null : autopay ? 1 : 0, accountId).run();
}
