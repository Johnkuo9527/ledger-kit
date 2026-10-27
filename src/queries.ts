/// The read side, for the page and the connector. Every question
/// either of them asks becomes SQL here and an answer built by src/views.ts —
/// one builder per shape, so the page and Claude can never describe the same
/// line two different ways. Nothing in this file writes.
///
/// Two D1 limits shape the SQL (CONTRACT.md §3):
///   * at most 100 bound values per statement — a list of ids is bound as ONE
///     JSON string and opened with json_each, never as `IN (?, ?, …)`;
///   * a LIKE pattern is capped at 50 UTF-8 BYTES (16 Chinese characters) —
///     a merchant search is cut to MERCHANT_SEARCH_BYTES before it is bound.

import { NON_SPENDING_KINDS } from "./payees";
import { paymentsView, type CardPayment } from "./payments";
import { accountCoverage, type Coverage, type OverdueReason } from "./coverage";
import { addDays } from "./dates";
import type { Db } from "./db";
import { uploadsNeedingOwner, WAIT_PDF_PASSWORD } from "./upload-status";
import { formatMoney, money, type Money } from "./money";
import { reimbursableTotal, type ReimburseRange } from "./reimbursable";
import { Refused } from "./refused";
import { monthlyEquivalent } from "./subscriptions";
import { CARD_PAYMENT_WINDOW_DAYS, isSpending } from "./transfers";
import { tripLines } from "./trips";
import { creditText, fitsTopUpRule, GRAB, isWallet, looksLikeTopUp, lotValueLeft, smsDate, takesSms, toldOnly, walkLots, walletStates, type WalletAccount } from "./wallet";
import { SPENDING_KINDS, type Account, type Evidence, type EvidenceType, type LineKind, type LineRow, type Statement } from "./types";
import { homeCurrency, homeMoney, localDate } from "./home";
import { say, sayDayMonth, sayList, sayMoney } from "./words";
import {
	lineView,
	monthView,
	subscriptionView,
	totals,
	tripView,
	type LineFlag,
	type LineView,
	type MonthView,
	type SubscriptionRow,
	type SubscriptionView,
	type Totals,
	type TripRow,
	type TripView,
} from "./views";

/// What a line with no category is called in a group, and in a filter.
export const UNCATEGORISED = "Uncategorised";

/// The longest merchant search, in UTF-8 bytes AFTER escaping. Wrapped in two
/// `%` it stays under D1's 50-byte LIKE cap (a measured limit).
export const MERCHANT_SEARCH_BYTES = 44;

export const LINE_FLAGS: readonly LineFlag[] = ["missed_by_alerts", "not_on_statement", "unlinked_refund", "no_rate", "needs_review"];

// ------------------------------------------------------------------ filters

export interface LineFilter {
	from?: string | null;
	to?: string | null;
	account_id?: string | null;
	kind?: LineKind | null;
	category?: string | null;
	/// Free text matched against the merchant (and the note).
	merchant?: string | null;
	/// Only these lines (a trip's members, resolved by the caller).
	line_ids?: readonly string[] | null;
	reimbursable?: boolean | null;
	/// Lines carrying ANY of these flags.
	flags?: readonly LineFlag[] | null;
	provisional?: boolean | null;
}

/// Escape LIKE's wildcards and cut the text to the byte budget, never in the
/// middle of a character. Shorter text matches MORE lines, never fewer.
export function likeFragment(text: string, budget = MERCHANT_SEARCH_BYTES): string {
	const enc = new TextEncoder();
	let out = "";
	let bytes = 0;
	for (const ch of text.normalize("NFKC").trim()) {
		const piece = ch === "\\" || ch === "%" || ch === "_" ? "\\" + ch : ch;
		const size = enc.encode(piece).length;
		if (bytes + size > budget) break;
		out += piece;
		bytes += size;
	}
	return out;
}

/// SGD the way the owner writes it in Chinese: S$186.88.
const sd = (minor: number) => sayMoney(minor, homeCurrency());

const SPENDING_SQL = [...SPENDING_KINDS].map((k) => `'${k}'`).join(", ");

/// Mirrors reimbursable() in src/reimbursable.ts: the owner's override first, then
/// a spending line inside any range. (Void lines are already filtered out.)
/// ⚠️ `IS 1`, never `= 1`: with no override, `= 1` is NULL, and NOT NULL is
/// NULL too — so "not reimbursable" silently dropped every line the owner had not
/// overridden. Every term here must be TRUE or FALSE, never NULL.
const REIMBURSABLE_SQL =
	"(l.kind <> 'wallet_offset' AND (l.reimbursable_override IS 1 OR (l.reimbursable_override IS NULL AND l.kind IN (" +
	SPENDING_SQL +
	") AND EXISTS (SELECT 1 FROM reimburse_ranges r WHERE l.txn_date BETWEEN r.start_date AND r.end_date))))";

/// Mirrors LineView.provisional: no statement yet, on an account that will have
/// one (statementAccountId() is not null).
const PROVISIONAL_SQL =
	"(l.statement_id IS NULL AND l.kind <> 'wallet_offset' AND l.account_id IN (SELECT id FROM accounts WHERE (kind = 'debit_card' AND settles_to IS NOT NULL) OR (kind NOT IN ('debit_card', 'cash') AND has_statements = 1)))";

const FLAG_SQL: Readonly<Record<LineFlag, string>> = {
	missed_by_alerts: "l.flag_missed_by_alerts = 1",
	not_on_statement: "l.flag_not_on_statement = 1",
	unlinked_refund: "l.flag_unlinked_refund = 1",
	no_rate: "l.flag_no_rate = 1",
	needs_review: "l.state = 'review'",
};

/// The WHERE clause for a filter. A void line or one merged into another is
/// never a real money movement, so neither is ever listed or counted.
export function filterSql(f: LineFilter): { where: string; args: unknown[] } {
	const w: string[] = ["l.state <> 'void'", "l.merged_into IS NULL"];
	const args: unknown[] = [];
	if (f.from) {
		w.push("l.txn_date >= ?");
		args.push(f.from);
	}
	if (f.to) {
		w.push("l.txn_date <= ?");
		args.push(f.to);
	}
	if (f.account_id) {
		// An income that offsets this account's spending is shown with it.
		w.push("(l.account_id = ? OR l.offset_account_id = ?)");
		args.push(f.account_id, f.account_id);
	}
	if (f.kind) {
		w.push("l.kind = ?");
		args.push(f.kind);
	}
	if (f.category) {
		if (f.category === UNCATEGORISED) {
			w.push("(l.category IS NULL OR l.category = ?)");
		} else {
			w.push("l.category = ?");
		}
		args.push(f.category);
	}
	if (f.merchant) {
		const frag = likeFragment(f.merchant);
		if (frag) {
			const pattern = `%${frag}%`;
			w.push("(l.merchant_name LIKE ? ESCAPE '\\' OR l.merchant_raw LIKE ? ESCAPE '\\' OR l.merchant_key LIKE ? ESCAPE '\\' OR l.note LIKE ? ESCAPE '\\')");
			args.push(pattern, pattern, pattern, pattern);
		}
	}
	if (f.line_ids) {
		w.push("l.id IN (SELECT value FROM json_each(?))");
		args.push(JSON.stringify(f.line_ids));
	}
	if (f.reimbursable === true) w.push(REIMBURSABLE_SQL);
	if (f.reimbursable === false) w.push(`NOT ${REIMBURSABLE_SQL}`);
	if (f.flags && f.flags.length) w.push(`(${f.flags.map((x) => FLAG_SQL[x]).join(" OR ")})`);
	if (f.provisional === true) w.push(PROVISIONAL_SQL);
	if (f.provisional === false) w.push(`NOT ${PROVISIONAL_SQL}`);
	return { where: w.join(" AND "), args };
}

// ------------------------------------------------------------------ lines

export type LineOrder = "date" | "amount";

const ORDER_SQL: Readonly<Record<LineOrder, string>> = {
	date: "l.txn_date DESC, l.created_at DESC, l.id DESC",
	// Spending first (a card bill is never the "top" purchase), then by size.
	amount: `CASE WHEN l.kind IN (${SPENDING_SQL}) THEN 0 ELSE 1 END, ABS(l.home_minor) DESC, l.txn_date DESC, l.id DESC`,
};

export async function loadLines(db: Db, f: LineFilter, order: LineOrder = "date", limit?: number): Promise<LineRow[]> {
	const { where, args } = filterSql(f);
	const sql = `SELECT l.* FROM lines l WHERE ${where} ORDER BY ${ORDER_SQL[order]}${limit ? " LIMIT ?" : ""}`;
	return (
		await db
			.prepare(sql)
			.bind(...args, ...(limit ? [limit] : []))
			.all<LineRow>()
	).results;
}

/// A page at a time: newest first by default, or by SGD amount (the owner's
/// "biggest spending"). The cursor is the last row's sort key ending in
/// (created_at, id), so a line added meanwhile never shifts the page.
export interface LinePage {
	lines: LineRow[];
	next_cursor: string | null;
}

export interface LineSort {
	by: "date" | "amount";
	order: "desc" | "asc";
}
export const DEFAULT_LINE_SORT: LineSort = { by: "date", order: "desc" };
export type LineCursor = { sort: LineSort; key: (string | number)[] };

const SORT_COLUMNS: Readonly<Record<LineSort["by"], readonly string[]>> = {
	date: ["l.txn_date", "l.created_at", "l.id"],
	amount: ["l.home_minor", "l.txn_date", "l.created_at", "l.id"],
};

function sortKey(l: Pick<LineRow, "txn_date" | "created_at" | "id" | "home_minor">, by: LineSort["by"]): (string | number)[] {
	return by === "date" ? [l.txn_date, l.created_at, l.id] : [l.home_minor, l.txn_date, l.created_at, l.id];
}

const b64 = (v: unknown) => btoa(JSON.stringify(v)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/// Newest-first cursors keep their old form (three strings), so a page link
/// made before sorting existed still works.
export function encodeCursor(l: Pick<LineRow, "txn_date" | "created_at" | "id"> & Partial<Pick<LineRow, "home_minor">>, sort: LineSort = DEFAULT_LINE_SORT): string {
	const key = sortKey({ home_minor: 0, ...l }, sort.by);
	return sort.by === "date" && sort.order === "desc" ? b64(key) : b64([sort.by, sort.order, ...key]);
}

/// null = not a cursor this code made.
export function decodeCursor(raw: string): LineCursor | null {
	try {
		const v = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/"))) as unknown;
		if (!Array.isArray(v)) return null;
		if (v.length === 3 && v.every((x) => typeof x === "string")) return { sort: DEFAULT_LINE_SORT, key: v as string[] };
		const [by, order, ...key] = v as unknown[];
		if ((order !== "desc" && order !== "asc") || (by !== "date" && by !== "amount")) return null;
		const ok = by === "date" ? key.length === 3 && key.every((x) => typeof x === "string") : key.length === 4 && Number.isInteger(key[0]) && key.slice(1).every((x) => typeof x === "string");
		return ok ? { sort: { by, order }, key: key as (string | number)[] } : null;
	} catch {
		return null;
	}
}

/// Sorting by amount lists SPENDING only (a card bill or a transfer is never
/// the "biggest spending"), unless the filter names a kind itself.
export async function linePage(db: Db, f: LineFilter, limit: number, cursor: LineCursor | null, sort: LineSort = DEFAULT_LINE_SORT): Promise<LinePage> {
	if (cursor && (cursor.sort.by !== sort.by || cursor.sort.order !== sort.order)) throw new Refused("that page cursor belongs to another sort order; start from the first page");
	const { where, args } = filterSql(f);
	const cols = SORT_COLUMNS[sort.by];
	const spendingOnly = sort.by === "amount" && !f.kind ? ` AND l.kind IN (${SPENDING_SQL})` : "";
	const after = cursor ? ` AND (${cols.join(", ")}) ${sort.order === "desc" ? "<" : ">"} (${cols.map(() => "?").join(", ")})` : "";
	const dir = sort.order === "desc" ? " DESC" : " ASC";
	const rows = (
		await db
			.prepare(`SELECT l.* FROM lines l WHERE ${where}${spendingOnly}${after} ORDER BY ${cols.map((c) => c + dir).join(", ")} LIMIT ?`)
			.bind(...args, ...(cursor ? cursor.key : []), limit + 1)
			.all<LineRow>()
	).results;
	const more = rows.length > limit;
	const lines = more ? rows.slice(0, limit) : rows;
	return { lines, next_cursor: more ? encodeCursor(lines[lines.length - 1]!, sort) : null };
}

/// totals() for every line a filter matches, added up by the database rather
/// than by loading them — for a page of lines that shows the whole filter's
/// sum. test/queries.test.ts holds it equal to totals() on the same lines.
export async function totalsFor(db: Db, f: LineFilter): Promise<Totals> {
	const { where, args } = filterSql(f);
	const spend = `l.kind IN (${SPENDING_SQL})`;
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(CASE WHEN ${spend} THEN l.home_minor END), 0) AS spending, ` +
				`COUNT(CASE WHEN ${spend} THEN 1 END) AS count, ` +
				`COALESCE(SUM(CASE WHEN ${spend} AND l.home_status IN ('estimate', 'reference') THEN l.home_minor END), 0) AS unconfirmed, ` +
				`COUNT(CASE WHEN l.flag_no_rate = 1 THEN 1 END) AS missing ` +
				`FROM lines l WHERE ${where}`,
		)
		.bind(...args)
		.first<{ spending: number; count: number; unconfirmed: number; missing: number }>();
	return {
		spending_home: homeMoney(row?.spending ?? 0),
		count: row?.count ?? 0,
		unconfirmed_home: homeMoney(row?.unconfirmed ?? 0),
		missing_rate_count: row?.missing ?? 0,
	};
}

// ------------------------------------------------------------- line views

export async function loadAccountMap(db: Db): Promise<Map<string, Account>> {
	const rows = (await db.prepare("SELECT * FROM accounts ORDER BY name").bind().all<Account>()).results;
	return new Map(rows.map((a) => [a.id, a]));
}

export async function loadRanges(db: Db): Promise<ReimburseRange[]> {
	return (await db.prepare("SELECT id, start_date, end_date, note FROM reimburse_ranges ORDER BY start_date").bind().all<ReimburseRange>()).results;
}

async function evidenceTypes(db: Db, lineIds: readonly string[]): Promise<Map<string, Set<EvidenceType>>> {
	const out = new Map<string, Set<EvidenceType>>();
	if (!lineIds.length) return out;
	const rows = (
		await db
			.prepare("SELECT line_id, type FROM evidence WHERE line_id IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify(lineIds))
			.all<{ line_id: string; type: EvidenceType }>()
	).results;
	for (const r of rows) (out.get(r.line_id) ?? out.set(r.line_id, new Set()).get(r.line_id)!).add(r.type);
	return out;
}

/// Everything a LineView needs besides the line. Built once per request.
export interface ViewContext {
	accounts: Map<string, Account>;
	ranges: ReimburseRange[];
	/// line id → the trip it belongs to: a confirmed trip, else a proposed one.
	tripOf: Map<string, string>;
}

/// A ViewContext on its way: its queries already sent, the accounts answered on
/// their own (a LineView's wallet questions need only them). Start one BEFORE
/// loading the lines it is for, and the two travel to D1 together (
/// 20 Oct 2026: every round trip to D1 is a hop the owner waits for on a tab switch).
export interface ViewContextLoad {
	accounts: Promise<Map<string, Account>>;
	ctx: Promise<ViewContext>;
}

export function startViewContext(db: Db): ViewContextLoad {
	const accounts = loadAccountMap(db);
	const ctx = Promise.all([accounts, loadRanges(db), tripsWithMembers(db, ["proposed", "confirmed"])]).then(([accounts, ranges, trips]) => {
		const tripOf = new Map<string, string>();
		// Confirmed trips first, so a line in both keeps the one the owner confirmed.
		for (const { trip, members } of [...trips].sort((a, b) => Number(b.trip.status === "confirmed") - Number(a.trip.status === "confirmed"))) {
			for (const l of members) if (!tripOf.has(l.id)) tripOf.set(l.id, trip.id);
		}
		return { accounts, ranges, tripOf };
	});
	// Whoever awaits them still gets any failure; this only stops an unawaited one (the
	// request failed first for another reason) from being reported as unhandled.
	accounts.catch(() => {});
	ctx.catch(() => {});
	return { accounts, ctx };
}

export async function viewContext(db: Db): Promise<ViewContext> {
	return startViewContext(db).ctx;
}

/// Each line as the page and the connector show it. Every query here goes out
/// at once — the line's evidence, subscriptions, wallet offsets and top-ups
/// ride with the trips and accounts of the context, one round trip, not five.
export async function lineViews(db: Db, rows: readonly LineRow[], ctx?: ViewContext | ViewContextLoad): Promise<LineView[]> {
	const load: ViewContextLoad = !ctx ? startViewContext(db) : ctx.accounts instanceof Map ? { accounts: Promise.resolve(ctx.accounts), ctx: Promise.resolve(ctx as ViewContext) } : (ctx as ViewContextLoad);
	const [c, types, subs, offsets, topups] = await Promise.all([
		load.ctx,
		evidenceTypes(
			db,
			rows.map((l) => l.id),
		),
		lineSubscriptions(db, rows),
		load.accounts.then((a) => walletOffsets(db, rows, a)),
		load.accounts.then((a) => walletTopUps(db, rows, a)),
	]);
	return rows.map((l) => {
		const account = c.accounts.get(l.account_id);
		if (!account) throw new Error(`line ${l.id} names an account that does not exist`);
		return {
			...lineView(l, account, types.get(l.id) ?? new Set(), c.ranges, c.tripOf.get(l.id) ?? null),
			subscription: subs.get(`${l.merchant_key}\u0000${l.orig_currency}`) ?? null,
			wallet: walletView(l, account, offsets.get(l.id) ?? null),
			topup: topups.get(l.id) ?? null,
		};
	});
}

/// Top-ups of a wallet among these lines, both legs (one query, only when a
/// transfer is among them): 「儲值 Sample Bistro S$200.00 → 240.00（預付，用掉時才算支出）」.
async function walletTopUps(db: Db, rows: readonly LineRow[], accounts: ReadonlyMap<string, Account>): Promise<Map<string, NonNullable<LineView["topup"]>>> {
	const out = new Map<string, NonNullable<LineView["topup"]>>();
	const groups = [...new Set(rows.filter((l) => l.kind === "transfer" && l.transfer_group).map((l) => l.transfer_group!))];
	if (!groups.length) return out;
	const legs = (
		await db
			.prepare("SELECT id, account_id, transfer_group, bill_minor, home_minor FROM lines WHERE transfer_group IN (SELECT value FROM json_each(?)) AND kind = 'transfer' AND state <> 'void' AND merged_into IS NULL")
			.bind(JSON.stringify(groups))
			.all<{ id: string; account_id: string; transfer_group: string; bill_minor: number; home_minor: number }>()
	).results;
	for (const g of groups) {
		const pair = legs.filter((x) => x.transfer_group === g);
		const into = pair.filter((x) => accounts.get(x.account_id)?.kind === "wallet" && x.bill_minor < 0);
		if (into.length !== 1) continue; // not money INTO one wallet (a wallet-to-bank move, or unpaired twice)
		const w = into[0]!;
		const wallet = accounts.get(w.account_id)!;
		const others = pair.filter((x) => x.id !== w.id);
		const src = others.length === 1 ? others[0]! : null;
		const from = src ? accounts.get(src.account_id) ?? null : null;
		const paid = homeMoney(-w.home_minor);
		const credit = creditText(-w.bill_minor);
		const bonus = -w.bill_minor !== -w.home_minor;
		const view = {
			wallet: { id: wallet.id, name: wallet.name },
			from: from ? { id: from.id, name: from.name } : null,
			source_line_id: src?.id ?? null,
			wallet_line_id: w.id,
			paid,
			credit,
			title: say("topup.title", { name: wallet.name }),
			message: say(bonus ? "topup.message_bonus" : "topup.message", { paid: sd(paid.minor), credit }),
		};
		out.set(w.id, { role: "wallet", ...view });
		if (src) out.set(src.id, { role: "source", ...view });
	}
	return out;
}

/// The live offsets of these wallet purchases (one query, only when a wallet line is among them).
async function walletOffsets(db: Db, rows: readonly LineRow[], accounts: ReadonlyMap<string, Account>): Promise<Map<string, { id: string; cents: number }>> {
	const ids = rows.filter((l) => l.kind !== "wallet_offset" && accounts.get(l.account_id)?.kind === "wallet").map((l) => l.id);
	const out = new Map<string, { id: string; cents: number }>();
	if (!ids.length) return out;
	const found = (
		await db
			.prepare("SELECT id, offset_of, home_minor FROM lines WHERE kind = 'wallet_offset' AND state <> 'void' AND offset_of IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify(ids))
			.all<{ id: string; offset_of: string; home_minor: number }>()
	).results;
	for (const r of found) out.set(r.offset_of, { id: r.id, cents: -r.home_minor });
	return out;
}

function walletView(l: LineRow, account: Account, offset: { id: string; cents: number } | null): LineView["wallet"] {
	if (account.kind !== "wallet") return null;
	if (l.kind === "wallet_offset") {
		return { precounted: money(-l.home_minor, l.bill_currency), offset_line_id: l.id, offset_of: l.offset_of ?? null, message: say("wallet.offset_message", { name: account.name, amount: money(-l.home_minor, l.bill_currency).display }) };
	}
	if (!offset) return null;
	const whole = offset.cents >= l.home_minor;
	return {
		precounted: money(offset.cents, l.bill_currency),
		offset_line_id: offset.id,
		offset_of: null,
		message: whole
			? say("wallet.paid_precounted", { name: account.name })
			: say("wallet.paid_part_precounted", { name: account.name, amount: money(offset.cents, l.bill_currency).display }),
	};
}

/// Each merchant's subscription as a line shows it: the one the owner sees first
/// (訂閱中, then 可能已停止, 已取消, and only then one he set aside).
async function lineSubscriptions(db: Db, rows: readonly LineRow[]): Promise<Map<string, NonNullable<LineView["subscription"]>>> {
	const keys = [...new Set(rows.map((l) => l.merchant_key).filter((k): k is string => !!k))];
	const out = new Map<string, NonNullable<LineView["subscription"]>>();
	if (!keys.length) return out;
	const subs = (
		await db
			.prepare("SELECT id, merchant_key, currency, cadence, status, owner_status FROM subscriptions WHERE merchant_key IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify(keys))
			.all<Pick<SubscriptionRow, "id" | "merchant_key" | "currency" | "cadence" | "status" | "owner_status">>()
	).results;
	const rank = { active: 0, lapsed: 1, cancelled: 2, ignored: 3 } as const;
	for (const s of subs) {
		const status = s.owner_status ?? s.status;
		const key = `${s.merchant_key}\u0000${s.currency}`;
		const have = out.get(key);
		if (!have || rank[status] < rank[have.status]) out.set(key, { id: s.id, cadence: s.cadence, status });
	}
	return out;
}

// ------------------------------------------------------------------ groups

export interface GroupTotal {
	key: string;
	spending_home: Money;
	unconfirmed_home: Money;
	count: number;
}

export type GroupBy = "category" | "merchant" | "account" | "month";

/// Spending grouped, biggest first (by month: oldest first). Only spending
/// lines count, exactly as in totals().
export function groupTotals(lines: readonly LineRow[], by: GroupBy, accounts: ReadonlyMap<string, Account>): GroupTotal[] {
	const keyOf = (l: LineRow): string => {
		if (by === "category") return l.category ?? UNCATEGORISED;
		if (by === "merchant") return l.merchant_name ?? l.merchant_raw ?? "Unknown merchant";
		if (by === "account") return accounts.get(l.offset_account_id ?? l.account_id)?.name ?? l.offset_account_id ?? l.account_id;
		return l.txn_date.slice(0, 7);
	};
	const groups = new Map<string, LineRow[]>();
	for (const l of lines.filter(isSpending)) (groups.get(keyOf(l)) ?? groups.set(keyOf(l), []).get(keyOf(l))!).push(l);
	const out = [...groups].map(([key, ls]) => {
		const t = totals(ls);
		return { key, spending_home: t.spending_home, unconfirmed_home: t.unconfirmed_home, count: t.count };
	});
	return by === "month"
		? out.sort((a, b) => a.key.localeCompare(b.key))
		: out.sort((a, b) => b.spending_home.minor - a.spending_home.minor || a.key.localeCompare(b.key));
}

/// groupTotals() added up by the database, for a filter of any size: the
/// connector never loads two years of lines to answer "by category".
/// test/queries.test.ts holds it equal to groupTotals() on the same lines.
const GROUP_SQL: Readonly<Record<GroupBy, string>> = {
	category: `COALESCE(l.category, '${UNCATEGORISED}')`,
	merchant: "COALESCE(l.merchant_name, l.merchant_raw, 'Unknown merchant')",
	account: "COALESCE(l.offset_account_id, l.account_id)",
	month: "substr(l.txn_date, 1, 7)",
};

export async function groupTotalsFor(db: Db, f: LineFilter, by: GroupBy, accounts: ReadonlyMap<string, Account>): Promise<GroupTotal[]> {
	const { where, args } = filterSql(f);
	const rows = (
		await db
			.prepare(
				`SELECT ${GROUP_SQL[by]} AS key, SUM(l.home_minor) AS spending, ` +
					`COALESCE(SUM(CASE WHEN l.home_status IN ('estimate', 'reference') THEN l.home_minor END), 0) AS unconfirmed, COUNT(*) AS count ` +
					`FROM lines l WHERE ${where} AND l.kind IN (${SPENDING_SQL}) GROUP BY 1`,
			)
			.bind(...args)
			.all<{ key: string; spending: number; unconfirmed: number; count: number }>()
	).results;
	// Two accounts can share a name; their groups merge, exactly as in groupTotals().
	const merged = new Map<string, { spending: number; unconfirmed: number; count: number }>();
	for (const r of rows) {
		const key = by === "account" ? (accounts.get(r.key)?.name ?? r.key) : r.key;
		const m = merged.get(key) ?? { spending: 0, unconfirmed: 0, count: 0 };
		merged.set(key, { spending: m.spending + r.spending, unconfirmed: m.unconfirmed + r.unconfirmed, count: m.count + r.count });
	}
	const out = [...merged].map(([key, m]) => ({ key, spending_home: homeMoney(m.spending), unconfirmed_home: homeMoney(m.unconfirmed), count: m.count }));
	return by === "month"
		? out.sort((a, b) => a.key.localeCompare(b.key))
		: out.sort((a, b) => b.spending_home.minor - a.spending_home.minor || a.key.localeCompare(b.key));
}

export async function countFor(db: Db, f: LineFilter): Promise<number> {
	const { where, args } = filterSql(f);
	return (await db.prepare(`SELECT COUNT(*) AS n FROM lines l WHERE ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0;
}

// ------------------------------------------------------------------ coverage

/// How complete each active account is for a period ending `asOf`
/// (CONTRACT.md §5.6). `only` limits it to some accounts.
export async function coverageFor(db: Db, accounts: Iterable<Account>, asOf: string): Promise<Coverage[]> {
	// A lost card's statements count for the card that replaced it (round 2).
	const active = [...accounts].filter((a) => a.active === 1);
	// The statements, the last taps and (only when there is a wallet) its balance: one round trip.
	const [statements, taps, wallets] = await Promise.all([
		db
			.prepare("SELECT s.account_id AS account_id, s.period_end AS period_end, a.replaced_by AS replaced_by FROM statements s JOIN accounts a ON a.id = s.account_id")
			.bind()
			.all<Pick<Statement, "account_id" | "period_end"> & { replaced_by: string | null }>()
			.then((r) => r.results),
		db
			.prepare("SELECT l.account_id AS account_id, MAX(ev.txn_date) AS last FROM evidence ev JOIN lines l ON l.id = ev.line_id WHERE ev.type = 'apple_pay_shortcut' GROUP BY l.account_id")
			.bind()
			.all<{ account_id: string; last: string }>()
			.then((r) => r.results),
		walletStates(db, active),
	]);
	const lastTap = new Map(taps.map((t) => [t.account_id, t.last]));
	const before = (id: string) => [...new Set(statements.filter((x) => x.replaced_by === id).map((x) => x.account_id))];
	const out = active.map((a) => accountCoverage(a, statements, lastTap.get(a.id) ?? null, asOf, before(a.id), wallets.get(a.id) ?? null));
	// A statement that is late: say why, when the ledger knows (three more queries,
	// only then, once per bank — 台新 sends one bill for all its cards). The banks are asked together.
	const firstOf = new Map<string, Account>();
	for (const [i, c] of out.entries()) if (c.overdue && !firstOf.has(active[i]!.institution)) firstOf.set(active[i]!.institution, active[i]!);
	const reasons = new Map<string, OverdueReason | null>(
		await Promise.all(
			[...firstOf].map(async ([inst, a]) => {
				const ids = active.filter((x, j) => out[j]!.overdue && x.institution === inst).flatMap((x) => [x.id, ...before(x.id)]);
				return [inst, await overdueReasonFor(db, a, ids)] as const;
			}),
		),
	);
	for (const [i, c] of out.entries()) {
		if (!c.overdue) continue;
		const a = active[i]!;
		const reason = reasons.get(a.institution) ?? null;
		out[i] = accountCoverage(a, statements, lastTap.get(a.id) ?? null, asOf, before(a.id), wallets.get(a.id) ?? null, reason);
	}
	return out;
}

/// Why a card's next statement is late, from what the ledger holds: the newest
/// email from the address its statements came from, newer than the last one
/// read (locked by a PDF password, failed, or still being read); else the
/// bank's PDF-password alarm (some bill of the bank will not open); else no
/// such email since the last statement arrived. null = nothing to go on.
export async function overdueReasonFor(db: Db, account: Account, ids: readonly string[]): Promise<OverdueReason | null> {
	const [alarm, known] = await Promise.all([
		db.prepare("SELECT raised_at FROM alarms WHERE key = ? AND cleared_at IS NULL").bind(`pdf_password:${account.institution.toUpperCase()}`).first<{ raised_at: string }>(),
		db
			.prepare(`SELECT m.from_addr AS from_addr, MAX(m.received_at) AS last FROM statements s JOIN messages m ON m.gmail_id = s.message_id WHERE s.account_id IN (SELECT value FROM json_each(?)) GROUP BY m.from_addr`)
			.bind(JSON.stringify(ids))
			.all<{ from_addr: string | null; last: string }>(),
	]);
	const day = (iso: string) => {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : localDate(d);
	};
	const locked = alarm ? { kind: "pdf_password" as const, since: day(alarm.raised_at) } : null;
	const senders = known.results.filter((r) => r.from_addr);
	if (!senders.length) return locked;
	const lastArrived = senders.map((r) => r.last).sort().at(-1)!;
	const newer = (
		await db
			.prepare(
				"SELECT w.stage AS stage, w.error AS error FROM work w JOIN messages m ON m.gmail_id = w.gmail_id " +
					"WHERE m.from_addr IN (SELECT value FROM json_each(?)) AND m.received_at > ? AND (w.kind = 'statement' OR w.kind IS NULL) ORDER BY m.received_at DESC LIMIT 5",
			)
			.bind(JSON.stringify(senders.map((r) => r.from_addr)), lastArrived)
			.all<{ stage: string; error: string | null }>()
	).results;
	if (newer.some((w) => w.stage === "waiting" && w.error === WAIT_PDF_PASSWORD)) return locked ?? { kind: "pdf_password", since: null };
	if (newer.some((w) => w.stage === "failed")) return { kind: "read_failed", since: null };
	if (newer.some((w) => w.stage !== "done")) return { kind: "reading", since: null };
	// The bank's PDF warning stays open while ANY of its bills is locked — an
	// older one too (14 Oct 2026). It explains a late statement only
	// when nothing newer from the bank's address says otherwise: no mail since
	// the last statement read (the late one may have come from another address).
	return locked ?? { kind: "no_mail", since: day(lastArrived) };
}

// ------------------------------------------------------------------ overview

export interface CategoryTotal {
	category: string;
	spending_home: Money;
	unconfirmed_home: Money;
	count: number;
}

export interface OverviewView {
	month: string; // YYYY-MM
	from: string;
	to: string;
	totals: Totals;
	categories: CategoryTotal[];
	/// Accounts with spending this month, plus every active wallet (19 Oct 2026), even at S$0.00.
	by_account: { account_id: string; name: string; kind: Account["kind"] | null; spending_home: Money; unconfirmed_home: Money; count: number }[];
	/// The part of spending_home the owner's company pays back (ranges + his overrides).
	reimbursable_home: Money;
	income: { salary_home: Money; other_home: Money };
	coverage: Coverage[];
	/// Round 2: spending grouped by `group_by`, biggest first, each with its
	/// share of the period's spending (one decimal; refunds can make a share
	/// negative). Defaults to category.
	group_by: OverviewGroupBy;
	groups: OverviewGroup[];
	/// Round 2 (the owner's payee rules): money that LEFT his accounts this month and
	/// is not spending, one entry per kind in NON_SPENDING_KINDS order (zero
	/// when none): investment 投資轉帳, loan_repayment 還款, friend_transfer
	/// 朋友代付／換匯, transfer 自己帳戶互轉, card_payment 繳卡費.
	non_spending: NonSpendingTotal[];
}

export interface NonSpendingTotal {
	kind: (typeof NON_SPENDING_KINDS)[number];
	total_home: Money; // money out only (positive lines)
	count: number;
}

export function nonSpending(rows: readonly LineRow[]): NonSpendingTotal[] {
	return NON_SPENDING_KINDS.map((kind) => {
		const out = rows.filter((l) => l.state !== "void" && l.kind === kind && l.home_minor > 0);
		return { kind, total_home: homeMoney(out.reduce((a, l) => a + l.home_minor, 0)), count: out.length };
	});
}

export type OverviewGroupBy = "category" | "merchant";
export const OVERVIEW_GROUP_BYS: readonly OverviewGroupBy[] = ["category", "merchant"];

export interface OverviewGroup {
	key: string;
	spending_home: Money;
	unconfirmed_home: Money;
	count: number;
	share_pct: number | null; // null when the period's spending is zero
}

export function withShares(groups: readonly GroupTotal[], total: number): OverviewGroup[] {
	return groups.map((g) => ({ ...g, share_pct: total === 0 ? null : Math.round((g.spending_home.minor / total) * 1000) / 10 }));
}

export function monthBounds(month: string): { from: string; to: string } | null {
	const m = /^(\d{4})-(\d{2})$/.exec(month);
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	if (mo < 1 || mo > 12) return null;
	const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
	return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/// A calendar month by purchase date (CONTRACT.md §11.9).
export async function overview(db: Db, month: string, today: string, groupBy: OverviewGroupBy = "category"): Promise<OverviewView> {
	const b = monthBounds(month);
	if (!b) throw new RangeError("month must be YYYY-MM");
	// Every query goes out at once (20 Oct 2026); coverage follows the accounts.
	const accountsP = loadAccountMap(db);
	const coverageP = accountsP.then((a) => coverageFor(db, a.values(), b.to < today ? b.to : today));
	coverageP.catch(() => {}); // awaited below; this only marks it handled if an earlier query fails first
	const [accounts, rows, ranges] = await Promise.all([accountsP, loadLines(db, { from: b.from, to: b.to }), loadRanges(db)]);
	const coverage = await coverageP;
	const all = totals(rows);
	const byAccount = new Map<string, LineRow[]>();
	for (const l of rows.filter(isSpending)) {
		const id = l.offset_account_id ?? l.account_id; // an offset counts against the account it offsets
		(byAccount.get(id) ?? byAccount.set(id, []).get(id)!).push(l);
	}
	// Every active wallet is always listed, even in a month with no spending on it
	// (19 Oct 2026: a card holding only a top-up — a transfer, not spending — had
	// vanished from 帳戶). It shows S$0.00 and 0 lines; tapping it opens the wallet.
	for (const a of accounts.values()) if (a.kind === "wallet" && a.active === 1 && !byAccount.has(a.id)) byAccount.set(a.id, []);
	return {
		month,
		from: b.from,
		to: b.to,
		totals: all,
		categories: groupTotals(rows, "category", accounts).map((g) => ({ category: g.key, spending_home: g.spending_home, unconfirmed_home: g.unconfirmed_home, count: g.count })),
		by_account: [...byAccount]
			.map(([id, ls]) => {
				const t = totals(ls);
				return { account_id: id, name: accounts.get(id)?.name ?? id, kind: accounts.get(id)?.kind ?? null, spending_home: t.spending_home, unconfirmed_home: t.unconfirmed_home, count: t.count };
			})
			.sort((a, b2) => b2.spending_home.minor - a.spending_home.minor),
		reimbursable_home: homeMoney(reimbursableTotal(rows.filter(isSpending), ranges)),
		// Money in: the owner's salary, and other income he has not marked as an offset (positive = received).
		income: {
			salary_home: homeMoney(-rows.filter((l) => l.state !== "void" && l.kind === "income" && l.income_offset === "salary").reduce((a, l) => a + l.home_minor, 0)),
			other_home: homeMoney(-rows.filter((l) => l.state !== "void" && l.kind === "income" && l.income_offset !== "salary").reduce((a, l) => a + l.home_minor, 0)),
		},
		coverage,
		group_by: groupBy,
		groups: withShares(groupTotals(rows, groupBy, accounts), all.spending_home.minor),
		non_spending: nonSpending(rows),
	};
}

// ------------------------------------------------------------------ months

/// Statements, newest first. A debit card's months are its bank's.
export async function monthViews(db: Db, accountId?: string | null): Promise<MonthView[]> {
	let target: string | null = null;
	if (accountId) {
		const a = (await loadAccountMap(db)).get(accountId);
		if (!a) return [];
		target = a.kind === "debit_card" ? a.settles_to : a.id;
		if (!target) return [];
	}
	const rows = (
		await db
			.prepare(`SELECT * FROM statements${target ? " WHERE account_id = ?" : ""} ORDER BY period_end DESC, account_id`)
			.bind(...(target ? [target] : []))
			.all<Statement>()
	).results;
	return rows.map(monthView);
}

// ------------------------------------------------------------------ trips

export async function loadTrips(db: Db, statuses: readonly TripRow["status"][] = ["proposed", "confirmed", "dismissed"]): Promise<TripRow[]> {
	return (
		await db
			.prepare("SELECT * FROM trips WHERE status IN (SELECT value FROM json_each(?)) ORDER BY start_date DESC, id")
			.bind(JSON.stringify(statuses))
			.all<TripRow>()
	).results;
}

export async function loadTrip(db: Db, tripId: string): Promise<TripRow | null> {
	return db.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<TripRow>();
}

/// The booking lines of a trip: the lines the flight/hotel evidence that
/// proposed it is attached to, plus any 'auto' rows the daily run recorded.
export async function tripBookingLineIds(db: Db, trip: TripRow): Promise<string[]> {
	const rows = (
		await db
			.prepare(
				"SELECT line_id FROM evidence WHERE id IN (SELECT value FROM json_each(?)) AND line_id IS NOT NULL " +
					"UNION SELECT line_id FROM trip_lines WHERE trip_id = ? AND membership = 'auto'",
			)
			.bind(trip.evidence_ids_json, trip.id)
			.all<{ line_id: string }>()
	).results;
	return rows.map((r) => r.line_id).sort();
}

/// The lines that make up each trip's cost (src/trips.ts tripLines): overseas
/// spending in its dates, its bookings whenever paid, the owner's includes, minus
/// his excludes, and the refunds of all of those.
///
/// ⚠️ FIVE QUERIES, HOWEVER MANY TRIPS. D1 allows 50 queries per request on
/// Cloudflare's free plan, and every page load asks which trip each line is
/// in — a few queries PER trip would break the page once the owner has travelled
/// enough. All the trips' bookings, choices, candidates and refunds are read
/// at once, and each trip picks its own out in memory.
type BookingRow = { trip_id: string; line_id: string };
type ChoiceRow = { trip_id: string; line_id: string; membership: "included" | "excluded" };

/// The trips' bookings and the owner's choices, for trips named by id — or, `byStatus`,
/// for every trip in these statuses, so they can be read in the SAME round trip
/// as the trips themselves (tripsWithMembers).
function bookingsAndChoices(db: Db, json: string, byStatus: boolean): Promise<[BookingRow[], ChoiceRow[]]> {
	const trips = byStatus ? "SELECT id FROM trips WHERE status IN (SELECT value FROM json_each(?1))" : "SELECT value FROM json_each(?1)";
	const tripMatch = byStatus ? "t.status IN (SELECT value FROM json_each(?1))" : "t.id IN (SELECT value FROM json_each(?1))";
	return Promise.all([
		db
			.prepare(
				"SELECT t.id AS trip_id, ev.line_id AS line_id FROM trips t, json_each(t.evidence_ids_json) j JOIN evidence ev ON ev.id = j.value " +
					`WHERE ${tripMatch} AND ev.line_id IS NOT NULL ` +
					`UNION SELECT trip_id, line_id FROM trip_lines WHERE membership = 'auto' AND trip_id IN (${trips})`,
			)
			.bind(json)
			.all<BookingRow>()
			.then((r) => r.results),
		db
			.prepare(`SELECT trip_id, line_id, membership FROM trip_lines WHERE membership IN ('included', 'excluded') AND trip_id IN (${trips})`)
			.bind(json)
			.all<ChoiceRow>()
			.then((r) => r.results),
	]);
}

export async function membersFor(db: Db, trips: readonly TripRow[]): Promise<Map<string, LineRow[]>> {
	if (!trips.length) return new Map();
	const [bookingRows, choices] = await bookingsAndChoices(db, JSON.stringify(trips.map((t) => t.id)), false);
	return membersFrom(db, trips, bookingRows, choices);
}

async function membersFrom(db: Db, trips: readonly TripRow[], bookingRows: readonly BookingRow[], choices: readonly ChoiceRow[]): Promise<Map<string, LineRow[]>> {
	const out = new Map<string, LineRow[]>(trips.map((t) => [t.id, []]));
	if (!trips.length) return out;
	const tripIds = JSON.stringify(trips.map((t) => t.id));
	const named = [...new Set([...bookingRows.map((b) => b.line_id), ...choices.filter((c) => c.membership === "included").map((c) => c.line_id)])];
	const candidates = (
		await db
			.prepare(
				"SELECT l.* FROM lines l WHERE l.state <> 'void' AND l.merged_into IS NULL AND (" +
					"EXISTS (SELECT 1 FROM trips t WHERE t.id IN (SELECT value FROM json_each(?)) AND l.txn_date BETWEEN t.start_date AND t.end_date) " +
					"OR l.id IN (SELECT value FROM json_each(?)))",
			)
			.bind(tripIds, JSON.stringify(named))
			.all<LineRow>()
	).results;
	const inputs = new Map(
		trips.map((t) => [
			t.id,
			{
				start_date: t.start_date,
				end_date: t.end_date,
				booking_line_ids: bookingRows.filter((b) => b.trip_id === t.id).map((b) => b.line_id).sort(),
				overrides: new Map(choices.filter((c) => c.trip_id === t.id).map((c) => [c.line_id, c.membership] as const)),
			},
		]),
	);
	const firstMembers = new Set(trips.flatMap((t) => tripLines(inputs.get(t.id)!, candidates).map((l) => l.id)));
	// A refund belongs wherever its purchase does, even when it came weeks later.
	const refunds = (
		await db
			.prepare("SELECT l.* FROM lines l WHERE l.kind = 'refund' AND l.state <> 'void' AND l.merged_into IS NULL AND l.refund_of IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify([...firstMembers]))
			.all<LineRow>()
	).results;
	const seen = new Set(candidates.map((l) => l.id));
	const all = [...candidates, ...refunds.filter((r) => !seen.has(r.id))];
	for (const t of trips) {
		out.set(
			t.id,
			tripLines(inputs.get(t.id)!, all).sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id)),
		);
	}
	return out;
}

export async function tripMembers(db: Db, trip: TripRow): Promise<LineRow[]> {
	return (await membersFor(db, [trip])).get(trip.id)!;
}

/// One trip and its lines by its id, the trip read in the same round trip as its
/// bookings and the owner's choices. null = no such trip.
export async function tripWithMembers(db: Db, tripId: string): Promise<{ trip: TripRow; members: LineRow[] } | null> {
	const [trip, [bookingRows, choices]] = await Promise.all([loadTrip(db, tripId), bookingsAndChoices(db, JSON.stringify([tripId]), false)]);
	if (!trip) return null;
	return { trip, members: (await membersFrom(db, [trip], bookingRows, choices)).get(trip.id)! };
}

/// The trips, their bookings and the owner's choices travel together (one round trip),
/// then the candidate lines, then their refunds: three round trips, however many trips.
export async function tripsWithMembers(db: Db, statuses: readonly TripRow["status"][]): Promise<{ trip: TripRow; members: LineRow[] }[]> {
	const [trips, [bookingRows, choices]] = await Promise.all([loadTrips(db, statuses), bookingsAndChoices(db, JSON.stringify(statuses), true)]);
	const members = await membersFrom(db, trips, bookingRows, choices);
	return trips.map((trip) => ({ trip, members: members.get(trip.id)! }));
}

export async function tripViews(db: Db, statuses?: readonly TripRow["status"][]): Promise<TripView[]> {
	const [ranges, trips] = await Promise.all([loadRanges(db), tripsWithMembers(db, statuses ?? ["proposed", "confirmed", "dismissed"])]);
	return trips.map(({ trip, members }) => tripView(trip, members, ranges));
}

export async function oneTripView(db: Db, tripId: string): Promise<{ trip: TripView; members: LineRow[] } | null> {
	const trip = await loadTrip(db, tripId);
	if (!trip) return null;
	const members = await tripMembers(db, trip);
	return { trip: tripView(trip, members, await loadRanges(db)), members };
}

// ------------------------------------------------------------- subscriptions

export interface SubscriptionsView {
	subscriptions: SubscriptionView[];
	/// What the active ones cost a month in SGD, from each one's latest real
	/// charge (so a USD subscription carries its card's true markup).
	monthly_total_home: Money;
	/// Active subscriptions left out of the total: no charge with an SGD figure.
	monthly_total_missing: number;
}

export async function subscriptionsView(db: Db, which: "active" | "all"): Promise<SubscriptionsView> {
	const rows = (await db.prepare("SELECT * FROM subscriptions ORDER BY COALESCE(merchant_name, merchant_key), cadence").bind().all<SubscriptionRow>()).results;
	const ids = rows.flatMap((s) => (JSON.parse(s.line_ids_json) as string[]).slice(-1));
	const latest = new Map(
		(
			await db
				.prepare("SELECT id, home_minor, state FROM lines WHERE id IN (SELECT value FROM json_each(?))")
				.bind(JSON.stringify(ids))
				.all<{ id: string; home_minor: number; state: string }>()
		).results.map((l) => [l.id, l]),
	);
	let total = 0;
	let missing = 0;
	const views: SubscriptionView[] = [];
	for (const s of rows) {
		const v = subscriptionView(s);
		if (v.status === "active") {
			const last = latest.get((JSON.parse(s.line_ids_json) as string[]).at(-1) ?? "");
			if (last && last.state !== "void") total += monthlyEquivalent({ cadence: s.cadence, amount_minor: last.home_minor });
			else if (s.currency === homeCurrency()) total += monthlyEquivalent(s);
			else missing++;
		}
		if (which === "all" || v.status === "active") views.push(v);
	}
	return { subscriptions: views, monthly_total_home: homeMoney(total), monthly_total_missing: missing };
}

// ------------------------------------------------------------------ needs the owner

/// Meeting point A (round 2): every item waiting on the owner carries the buttons
/// that answer it. The page draws them as they are and POSTs `path` with
/// `body` (+ the picked choice as body[choice_key]); after a success it
/// fetches the list again. An action without `path` is instructions only.
export interface OkChoice {
	value: string;
	label: string;
}

export interface OkAction {
	id: string;
	label: string;
	method: "POST";
	path: string;
	body: Record<string, unknown>;
	style: "primary" | "secondary" | "danger";
	choices?: OkChoice[];
	choice_key?: string;
	choice_label?: string;
	/// One plain number field to fill before the button (19 Oct 2026: the credit
	/// a top-up gave): sent as body[input_key]; `input_value` prefills it.
	input_key?: string;
	input_label?: string;
	input_value?: string;
}

export interface HeldTap {
	evidence_id: string;
	/// The Wallet card name as the ledger keys it (case and punctuation ignored).
	card: string;
	merchant: string | null;
	amount: Money;
	date: string;
	time: string | null;
	received_at: string;
	actions: OkAction[];
}

/// A bank alert or statement line the rules could not place on a line.
export interface HeldItem {
	id: string; // the evidence id
	type: "alert" | "statement_line";
	title: string;
	detail: string;
	actions: OkAction[];
}

/// A bank whose statement PDF would not open: what the owner does about it.
export interface PdfPasswordItem {
	id: string; // the bank, e.g. "taishin"
	title: string;
	detail: string;
	instructions: string;
	actions: OkAction[];
}

/// An uploaded statement PDF waiting on the owner (src/upload-status.ts).
export interface UploadItem {
	id: string; // the upload's key (as in /api/statements/uploads/:id/…)
	state: "needs_account" | "needs_password" | "failed";
	filename: string;
	title: string;
	detail: string;
	actions: OkAction[];
}

export interface NeedsOkView {
	trips: (TripView & { actions: OkAction[] })[]; // proposed, waiting for him to confirm or dismiss
	held_taps: HeldTap[]; // Apple Pay taps from a Wallet card name not on the account list
	lines: (LineView & { actions: OkAction[] })[]; // in review, not on their statement, unlinked refunds, no rate
	months: (MonthView & { actions: OkAction[] })[]; // statements that did not add up, bills that did not match
	held: HeldItem[]; // round 2: alerts and statement lines the rules could not place (newest first)
	pdf_passwords: PdfPasswordItem[]; // round 2: statements waiting for a PDF password
	uploads: UploadItem[]; // statement PDFs the owner uploaded that wait on him (a card to pick, a lock, a failure)
	/// (14 Oct 2026): card bills with evidence they were not paid — past the due
	/// date with no payment seen (not auto-debit), or the next statement shows them unpaid.
	bills: BillItem[];
	/// (19 Oct 2026): a prepaid card topped up by the rule (a round amount at
	/// the shop) — the ledger cannot know a bonus: 「這次儲值有送嗎？」
	wallet_topups: WalletItem[];
	/// (19 Oct 2026): a shop's SMS whose balance differs from the ledger's,
	/// or that could not be read (src/wallet-sms.ts).
	wallet_sms: WalletItem[];
	other_held: number; // held items beyond the `held` list
	count: number;
}

/// A prepaid-wallet question waiting on the owner (CONTRACT.md §15.2).
export interface WalletItem {
	id: string; // the top-up's wallet-side line id, or the SMS's id
	account_id: string;
	title: string;
	detail: string;
	actions: OkAction[];
}

/// The wallet questions: top-ups the rule made on a prepaid card (not GrabPay,
/// and not a card whose usual deal is on its row — 範例's "pay 300 get 350")
/// that the owner has not answered (lines.owner_ok has no "bonus"), and SMS checks.
async function walletItems(db: Db): Promise<{ topups: WalletItem[]; sms: WalletItem[] }> {
	const legs = (
		await db
			.prepare(
				"SELECT l.id, l.account_id, l.txn_date, l.bill_minor, l.home_minor, a.name AS wallet, (SELECT f.name FROM accounts f WHERE f.id = l.counter_account_id) AS source FROM lines l JOIN accounts a ON a.id = l.account_id " +
					"WHERE a.kind = 'wallet' AND a.institution <> 'grab' AND a.wallet_topup_deal_paid_minor IS NULL AND l.kind = 'transfer' AND l.bill_minor < 0 AND l.state <> 'void' AND l.transfer_group IS NOT NULL " +
					"AND (',' || COALESCE(l.owner_ok, '') || ',') NOT LIKE '%,bonus,%' ORDER BY l.txn_date DESC, l.id LIMIT 20",
			)
			.bind()
			.all<{ id: string; account_id: string; txn_date: string; bill_minor: number; home_minor: number; wallet: string; source: string | null }>()
	).results;
	const topups = legs.map((l) => {
		const paid = -l.home_minor;
		const path = `/api/wallet-topups/${enc(l.id)}/credit`;
		return {
			id: l.id,
			account_id: l.account_id,
			title: say("ok.topup_bonus_title", { wallet: l.wallet }),
			detail: say(l.source ? "ok.topup_bonus_detail_from" : "ok.topup_bonus_detail", { date: l.txn_date, source: l.source ?? "", paid: formatMoney(paid, homeCurrency()), credit: creditText(-l.bill_minor) }),
			actions: [
				act("credit", say("ok.topup_bonus_yes"), path, {}, "primary", { input_key: "credit", input_label: say("ok.topup_bonus_input"), input_value: creditText(paid) }),
				act("none", say("ok.topup_bonus_no"), path, { credit: null }),
			],
		};
	});
	const rows = (
		await db
			.prepare(
				"SELECT s.id, s.account_id, s.state, s.text, s.received_at, s.spent_minor, s.balance_minor, s.ledger_balance_minor, s.error, a.name AS wallet FROM wallet_sms s JOIN accounts a ON a.id = s.account_id " +
					"WHERE s.check_state = 'mismatch' OR s.state = 'failed' ORDER BY s.received_at DESC LIMIT 20",
			)
			.bind()
			.all<{ id: string; account_id: string; state: string; text: string; received_at: string; spent_minor: number | null; balance_minor: number | null; ledger_balance_minor: number | null; error: string | null; wallet: string }>()
	).results;
	const sms = rows.map((r) => {
		const day = smsDate(r.received_at);
		if (r.state === "failed") {
			return {
				id: r.id,
				account_id: r.account_id,
				title: say("ok.sms_unread_title", { wallet: r.wallet }),
				detail: say("ok.sms_unread_detail", { date: day, text: r.text.slice(0, 200), wallet: r.wallet }),
				actions: [act("dismiss", say("ok.sms_unread_dismiss"), `/api/wallet-sms/${enc(r.id)}/dismiss`, {}, "primary")],
			};
		}
		const out = (r.ledger_balance_minor ?? 0) - (r.balance_minor ?? 0);
		return {
			id: r.id,
			account_id: r.account_id,
			title: say("ok.sms_check_title", { wallet: r.wallet, balance: creditText(r.balance_minor ?? 0), ledger: creditText(r.ledger_balance_minor ?? 0) }),
			detail:
				say("ok.sms_check_detail", { date: day, spent: creditText(r.spent_minor ?? 0), balance: creditText(r.balance_minor ?? 0) }) +
				(out > 0 ? say("ok.sms_check_more", { amount: creditText(out) }) : say("ok.sms_check_less", { amount: creditText(-out) })),
			actions: [
				act("accept", say("ok.sms_check_accept"), `/api/wallet-sms/${enc(r.id)}/accept`, {}, "primary"),
				act("checked", say("ok.sms_check_myself"), `/api/wallet-sms/${enc(r.id)}/checked`, {}),
			],
		};
	});
	return { topups, sms };
}

/// A card bill waiting on the owner (CONTRACT.md §16).
export interface BillItem {
	id: string; // "overdue:<statement id>" | "unpaid:<statement id>"
	kind: "overdue" | "unpaid_on_next_statement";
	account_id: string;
	statement_id: string;
	title: string;
	detail: string;
	actions: OkAction[];
}

/// 待確認 → 繳款: a bill past its due date with no payment seen (a card he pays
/// himself), and a bill the next statement shows was not paid in full (until
/// The owner has seen it). Built from the same view as 繳款, so the two agree.
export function billItems(cards: readonly CardPayment[]): BillItem[] {
	const out: BillItem[] = [];
	const md = (d: string | null) => (d ? sayDayMonth(d) : "");
	for (const c of cards) {
		const p = c.previous_bill;
		if (p && p.verdict === "unpaid" && !p.seen_by_owner) {
			const gap = p.statement_balance && p.payments_credited ? money(Math.max(0, p.statement_balance.minor - p.payments_credited.minor), p.statement_balance.currency) : null;
			const why =
				p.reason === "balance_carried"
					? say(gap ? "ok.bill_carried_gap" : "ok.bill_carried", { paid: p.payments_credited?.display ?? "0", bill: p.statement_balance?.display ?? "?", gap: gap?.display ?? "" })
					: say("ok.bill_late_fee");
			out.push({
				id: `unpaid:${p.statement_id}`,
				kind: "unpaid_on_next_statement",
				account_id: c.account.id,
				statement_id: p.statement_id,
				title: say("ok.bill_unpaid_title", { name: c.account.name, day: md(p.period_to) }),
				detail: `${why}${p.owner_said_paid ? say("ok.bill_unpaid_said_paid") : ""}`,
				actions: [act("seen", say("ok.seen"), `/api/payments/${enc(p.statement_id)}/seen`, {}, "primary")],
			});
		}
		if (c.status === "overdue" && c.status_reason === "no_payment_seen" && c.last_statement) {
			out.push({
				id: `overdue:${c.last_statement.statement_id}`,
				kind: "overdue",
				account_id: c.account.id,
				statement_id: c.last_statement.statement_id,
				title: say("ok.bill_overdue_title", { name: c.account.name, day: md(c.due_date) }),
				detail: say("ok.bill_overdue_detail", { amount: c.outstanding.display }),
				actions: [
					act("paid", say("ok.bill_i_paid"), `/api/payments/${enc(c.last_statement.statement_id)}/paid`, { paid: true }, "primary"),
					act("autopay", say("ok.bill_autopay"), `/api/accounts/${enc(c.account.id)}/settings`, { autopay: true }),
				],
			});
		}
	}
	return out;
}

export const NEEDS_OK_LINE_LIMIT = 100;
export const NEEDS_OK_HELD_LIMIT = 50;
/// The PDF-password warning's two parts (worker/src/pdf-locks.ts lockedMessage writes
/// them, in the owner's language; a warning written in another one is shown whole).
export const fixMark = () => say("pdf.fix_mark");
export const waitMark = () => say("pdf.wait_mark");
/// A bank's name in words, for a warning or a held item: the example banks the kit
/// ships readers for, else the institution id in capitals.
const BANK_NAMES: Readonly<Record<string, string>> = { dbs: "DBS", hsbc: "HSBC", citi: "Citi", grab: "Grab", "sample-bistro": "Sample Bistro" };
export const bankName = (institution: string): string => (institution === "taishin" ? say("bank.taishin") : BANK_NAMES[institution] ?? institution.toUpperCase());

const act = (id: string, label: string, path: string, body: Record<string, unknown>, style: OkAction["style"] = "secondary", extra: Partial<OkAction> = {}): OkAction => ({ id, label, method: "POST", path, body, style, ...extra });
const enc = encodeURIComponent;

/// Uploaded statements waiting on the owner. A card to pick (the one on the PDF
/// matches no account, or no password opened it): one chip per card or bank
/// account, and the ledger reads it again for that card.
async function uploadItems(db: Db): Promise<UploadItem[]> {
	const waiting = await uploadsNeedingOwner(db);
	if (!waiting.length) return [];
	const owned = (await db.prepare("SELECT id, name FROM accounts WHERE kind IN ('credit_card', 'bank') AND active = 1 ORDER BY institution, name").bind().all<{ id: string; name: string }>()).results.map((a) => ({ value: a.id, label: a.name }));
	return waiting.map(({ view }) => {
		const p = `/api/statements/uploads/${enc(view.id)}`;
		const dismiss = (label: string) => act("dismiss", label, `${p}/dismiss`, {}, "danger");
		if (view.state === "needs_account" || view.state === "needs_password") {
			const locked = view.state === "needs_password";
			return {
				id: view.id,
				state: view.state,
				filename: view.filename,
				title: say(locked ? "ok.upload_locked_title" : "ok.upload_which_title", { file: view.filename }),
				detail: locked ? say("ok.upload_locked_detail") : view.unknown_last4.length ? say("upload.no_card_digits_pick", { digits: sayList(view.unknown_last4) }) : say("upload.no_card_pick"),
				actions: [act("account", say("ok.this_one"), `${p}/account`, {}, "primary", { choice_key: "account_id", choice_label: say("ok.upload_which_q"), choices: owned }), dismiss(say("ok.upload_skip"))],
			};
		}
		return { id: view.id, state: "failed" as const, filename: view.filename, title: say("ok.upload_failed_title", { file: view.filename }), detail: view.message, actions: [dismiss(say("ok.seen"))] };
	});
}

/// The actions of one flagged line, by what is wrong with it.
function lineActions(v: LineView, line: LineRow, categories: readonly string[], originals: readonly LineRow[], picks: ReadonlyMap<string, readonly LineRow[]> = new Map()): OkAction[] {
	const p = `/api/lines/${enc(v.id)}/review`;
	const out: OkAction[] = [];
	const legs = picks.get(line.id);
	if (legs) {
		// A card's payment received that two bank lines fit equally: the owner picks.
		const choices = legs.map((o) => ({ value: o.id, label: `${o.txn_date} ${o.merchant_raw ?? say("ok.no_payee")} ${money(o.bill_minor, o.bill_currency).display}`.trim() }));
		if (choices.length) out.push(act("pair", say("ok.pair_this"), p, { action: "pair" }, "primary", { choice_key: "line_id", choice_label: say("ok.pair_q"), choices }));
		out.push(act("accept", say("ok.pair_none"), p, { action: "accept" }, choices.length ? "secondary" : "primary"));
		return out;
	}
	if (line.flag_no_rate === 1) {
		out.push(act("retry_rate", say("ok.retry_rate"), p, { action: "retry_rate" }, "primary"));
		out.push(act("accept", say("ok.leave_for_now"), p, { action: "accept" }));
	} else if (line.flag_unlinked_refund === 1) {
		const picks = originals
			.filter((o) => o.merchant_key === line.merchant_key && o.txn_date <= line.txn_date && o.id !== line.id)
			.slice(0, 6)
			.map((o) => ({ value: o.id, label: `${o.txn_date} ${o.merchant_name ?? o.merchant_raw ?? ""} ${money(o.bill_minor, o.bill_currency).display}`.trim() }));
		if (picks.length) out.push(act("link", say("ok.refund_link"), p, { action: "link" }, "primary", { choice_key: "refund_of", choice_label: say("ok.refund_q"), choices: picks }));
		out.push(act("accept", say("ok.refund_alone"), p, { action: "accept" }, picks.length ? "secondary" : "primary"));
	} else if (line.flag_not_on_statement === 1) {
		out.push(act("accept", say("ok.real_purchase"), p, { action: "accept" }, "primary"));
		out.push(act("void", say("ok.void_hold"), p, { action: "void" }, "danger"));
	} else {
		out.push(act("accept", say("ok.fine"), p, { action: "accept" }, "primary"));
		out.push(act("void", say("ok.void_not_real"), p, { action: "void" }, "danger"));
	}
	if (categories.length && (line.kind === "purchase" || line.kind === "refund") && line.flag_no_rate !== 1) {
		out.push(act("category", say("ok.fine_and_category"), p, { action: "accept" }, "secondary", { choice_key: "category", choice_label: say("ok.category_q"), choices: categories.map((c) => ({ value: c, label: c })) }));
	}
	return out;
}

/// The bank lines the owner may pick from for a card payment waiting in 待確認:
/// money out of a bank account of exactly its amount, ±5 days, not paired.
async function paymentPicks(db: Db, card: LineRow): Promise<LineRow[]> {
	return (
		await db
			.prepare(
				"SELECT * FROM lines WHERE state <> 'void' AND transfer_group IS NULL AND kind IN ('purchase', 'transfer') AND bill_currency = ? AND bill_minor = ? AND txn_date BETWEEN ? AND ? " +
					"AND account_id IN (SELECT id FROM accounts WHERE kind = 'bank') ORDER BY txn_date, id LIMIT 10",
			)
			.bind(card.bill_currency, -card.bill_minor, addDays(card.txn_date, -CARD_PAYMENT_WINDOW_DAYS), addDays(card.txn_date, CARD_PAYMENT_WINDOW_DAYS))
			.all<LineRow>()
	).results;
}

export async function needsOk(db: Db, opts: { categories?: readonly string[]; today?: string } = {}): Promise<NeedsOkView> {
	// Every kind of question is read at once (20 Oct 2026: thirty round trips
	// one after another made 待確認 the slowest tab); each keeps its own order inside.
	const proposedP = Promise.all([loadRanges(db), tripsWithMembers(db, ["proposed"])]).then(([ranges, trips]) =>
		trips.map(({ trip, members }) => ({
			...tripView(trip, members, ranges),
			actions: [act("confirm", say("ok.trip_yes"), `/api/trips/${enc(trip.id)}/confirm`, {}, "primary"), act("reject", say("ok.trip_no"), `/api/trips/${enc(trip.id)}/reject`, {})],
		})),
	);
	const tapsP = Promise.all([
		db.prepare("SELECT id, name FROM accounts WHERE kind IN ('credit_card', 'debit_card') AND active = 1 ORDER BY institution, name").bind().all<{ id: string; name: string }>(),
		db.prepare("SELECT * FROM evidence WHERE type = 'apple_pay_shortcut' AND line_id IS NULL AND dismissed_at IS NULL ORDER BY txn_date DESC, txn_time DESC").bind().all<Evidence>(),
	]).then(([cardRows, tapRows]) => {
		const cards = cardRows.results.map((a) => ({ value: a.id, label: a.name }));
		return tapRows.results.map((ev) => {
			const card = (JSON.parse(ev.details_json ?? "{}") as { wallet_key?: string }).wallet_key ?? "";
			return {
				evidence_id: ev.id,
				card,
				merchant: ev.merchant_raw,
				amount: money(ev.amount_minor, ev.currency),
				date: ev.txn_date,
				time: ev.txn_time,
				received_at: ev.created_at,
				actions: [
					act("assign", say("ok.this_one"), "/api/wallet-names", { name: card }, "primary", { choice_key: "account_id", choice_label: say("ok.tap_card_q", { card }), choices: cards }),
					act("dismiss", say("ok.tap_not_mine"), `/api/needs-ok/held/${enc(ev.id)}/dismiss`, { reason: "not_mine" }),
				],
			};
		});
	});
	const viewCtx = startViewContext(db); // sent with the flagged lines, not after them
	const linesP = (async () => {
		const rows = await loadLines(db, { flags: ["needs_review", "not_on_statement", "unlinked_refund", "no_rate"] }, "date", NEEDS_OK_LINE_LIMIT);
		const refunds = rows.filter((l) => l.flag_unlinked_refund === 1 && l.merchant_key);
		const cardPays = rows.filter((l) => l.kind === "card_payment" && l.bill_minor < 0 && l.state === "review" && l.transfer_group === null);
		const [views, originals, pickLists] = await Promise.all([
			lineViews(db, rows, viewCtx),
			refunds.length
				? db
						.prepare("SELECT * FROM lines WHERE kind = 'purchase' AND state <> 'void' AND bill_minor > 0 AND merchant_key IN (SELECT value FROM json_each(?)) AND txn_date >= ? ORDER BY txn_date DESC LIMIT 200")
						.bind(JSON.stringify([...new Set(refunds.map((l) => l.merchant_key!))]), addDays(refunds.map((l) => l.txn_date).sort()[0]!, -365))
						.all<LineRow>()
						.then((r) => r.results)
				: Promise.resolve([] as LineRow[]),
			Promise.all(cardPays.map((l) => paymentPicks(db, l))),
		]);
		const picks = new Map<string, LineRow[]>(cardPays.map((l, i) => [l.id, pickLists[i]!]));
		return views.map((v) => ({ ...v, actions: lineActions(v, rows.find((r) => r.id === v.id)!, opts.categories ?? [], originals, picks) }));
	})();
	const monthsP = db
		.prepare("SELECT * FROM statements WHERE reviewed_at IS NULL AND (recon_status = 'escalated' OR bill_check = 'mismatch') ORDER BY period_end DESC")
		.bind()
		.all<Statement>()
		.then((r) =>
			r.results.map((s) => ({
				...monthView(s),
				actions: [
					act("reviewed", say("ok.month_reviewed"), `/api/months/${enc(s.id)}/reviewed`, {}, "primary"),
					act("recheck", say("ok.month_recheck"), `/api/months/${enc(s.id)}/recheck`, {}),
				],
			})),
		);
	const heldRowsP = db
		.prepare("SELECT * FROM evidence WHERE line_id IS NULL AND dismissed_at IS NULL AND type IN ('alert', 'statement_line') ORDER BY txn_date DESC, id LIMIT ?")
		.bind(NEEDS_OK_HELD_LIMIT)
		.all<Evidence>()
		.then((r) => r.results);
	const heldTotalP = db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE line_id IS NULL AND dismissed_at IS NULL AND type IN ('alert', 'statement_line')").bind().first<{ n: number }>();
	const pdfP = db
		.prepare("SELECT key, message FROM alarms WHERE key LIKE 'pdf_password:%' AND cleared_at IS NULL ORDER BY key")
		.bind()
		.all<{ key: string; message: string }>()
		.then((r) => r.results);
	const uploadsP = uploadItems(db);
	const billsP = paymentsView(db, opts.today ?? todayLocal()).then((p) => billItems(p.cards));
	const walletP = walletItems(db);
	const [proposed, taps, lines, months, heldRows, heldTotal, pdfRows, uploads, bills, wallet] = await Promise.all([proposedP, tapsP, linesP, monthsP, heldRowsP, heldTotalP, pdfP, uploadsP, billsP, walletP]);
	const held: HeldItem[] = heldRows.map((ev) => ({
		id: ev.id,
		type: ev.type as HeldItem["type"],
		title: `${ev.merchant_raw ?? say("ok.no_merchant")} · ${money(ev.amount_minor, ev.currency).display}`,
		detail: say(ev.type === "alert" ? "ok.held_alert" : "ok.held_statement", { date: ev.txn_date, bank: ev.institution ? bankName(ev.institution) : "", last4: ev.last4 ? say("ok.held_last4", { last4: ev.last4 }) : "" }),
		actions: [act("dismiss", say("ok.held_dismiss"), `/api/needs-ok/held/${enc(ev.id)}/dismiss`, { reason: "not_a_charge" }, "danger")],
	}));
	const pdf = pdfRows.map((a) => {
		const bank = a.key.slice("pdf_password:".length).toLowerCase();
		const name = bankName(bank);
		// The worker writes "<which bills><fix mark><the command><wait mark>…" (worker/src/pdf-locks.ts):
		// the bills go in the detail, the command in the steps. An older message is not split.
		const cut = a.message.indexOf(fixMark());
		const bills = cut > 0 ? a.message.slice(0, cut) : null;
		const fix = cut > 0 ? a.message.slice(cut + fixMark().length).split(waitMark())[0]!.trim() : null;
		return {
			id: bank,
			title: say("ok.pdf_title", { name }),
			detail: bills ? say("ok.pdf_detail_bills", { bills }) : say("ok.pdf_detail"),
			instructions: fix ? say("ok.pdf_steps_fix", { name, fix }) : say("ok.pdf_steps", { name, secret: `LEDGER_PDF_PW_${bank.toUpperCase()}` }),
			actions: [act("retry", say("ok.pdf_retry"), `/api/needs-ok/pdf/${enc(bank)}/retry`, {}, "primary")],
		};
	});
	return {
		trips: proposed,
		held_taps: taps,
		lines,
		months,
		held,
		pdf_passwords: pdf,
		uploads,
		bills,
		wallet_topups: wallet.topups,
		wallet_sms: wallet.sms,
		other_held: Math.max(0, (heldTotal?.n ?? 0) - held.length),
		count: proposed.length + taps.length + lines.length + months.length + held.length + pdf.length + uploads.length + bills.length + wallet.topups.length + wallet.sms.length,
	};
}

// ------------------------------------------------------------------ accounts

export interface AccountView {
	id: string;
	name: string;
	kind: Account["kind"];
	institution: string;
	currency: string;
	active: boolean;
	wallet_names: string[];
	/// Round 2 (C): a credit card's cut-off and payment due day (1–31, null =
	/// not known) and who set them — "owner" | "statement" (read off his
	/// statements) | null. null for every other account.
	statement_day: number | null;
	due_day: number | null;
	settings_source: "owner" | "statement" | null;
	/// The card that replaced this lost one (they are one card going forward); null = none.
	replaced_by: string | null;
	/// (14 Oct 2026), a credit card only: the owner's word that it is paid by
	/// auto-debit (true) or by him (false); null = the ledger decides from its
	/// statements (繳款 `autopay` says what it decided).
	autopay: boolean | null;
	/// A wallet (GrabPay): recorded since, its balance now, and the part of it
	/// already counted as spending at top-up that is still unspent. null otherwise.
	/// told_only (19 Oct 2026): a wallet with no statements and no mail (a prepaid
	/// restaurant card) — its balance is only what the owner told the ledger.
	/// topup_deal (19 Oct 2026): the shop's usual bonus ("pay 300, get 350"), which
	/// an automatic top-up gets by default and 「儲值到…」 prefills; null = none known.
	/// remaining_value (19 Oct 2026): what the credit left is worth in money (SGD), lot by lot.
	wallet: { since: string; balance: Money; precounted_left: Money; remaining_value: Money; precounted_category: string | null; told_only: boolean; topup_deal: { paid: Money; credit: Money } | null } | null;
}

export async function accountViews(db: Db): Promise<AccountView[]> {
	const accountsP = loadAccountMap(db);
	const [accounts, names, wallets] = await Promise.all([
		accountsP,
		db.prepare("SELECT wallet_key, account_id FROM account_wallet_names ORDER BY wallet_key").bind().all<{ wallet_key: string; account_id: string }>().then((r) => r.results),
		accountsP.then((a) => walletStates(db, [...a.values()])),
	]);
	return [...accounts.values()].map((a) => ({
		id: a.id,
		name: a.name,
		kind: a.kind,
		institution: a.institution,
		currency: a.currency,
		active: a.active === 1,
		wallet_names: names.filter((n) => n.account_id === a.id).map((n) => n.wallet_key),
		...cardDays(a),
		replaced_by: a.replaced_by ?? null,
		autopay: a.kind === "credit_card" && (a.autopay === 0 || a.autopay === 1) ? a.autopay === 1 : null,
		wallet: ((w) => (w ? { since: w.since, balance: w.balance, precounted_left: w.precounted_left, remaining_value: w.remaining_value, precounted_category: w.precounted_category, told_only: toldOnly(a), topup_deal: a.wallet_topup_deal_paid_minor && a.wallet_topup_deal_credit_minor ? { paid: money(a.wallet_topup_deal_paid_minor, a.currency), credit: money(a.wallet_topup_deal_credit_minor, a.currency) } : null } : null))(wallets.get(a.id)),
	}));
}

export function cardDays(a: Account): Pick<AccountView, "statement_day" | "due_day" | "settings_source"> {
	const card = a.kind === "credit_card";
	return { statement_day: card ? (a.statement_day ?? null) : null, due_day: card ? (a.due_day ?? null) : null, settings_source: card ? (a.settings_source ?? null) : null };
}

/// Today's date on the owner's calendar — the default end of every period.
export function todayLocal(now: Date = new Date()): string {
	return localDate(now);
}

// ------------------------------------------------------------------ one wallet (19 Oct 2026)

/// One prepaid wallet as the owner reads it when he taps it in 帳戶 (CONTRACT §15.3,
/// The owner: "If I can't see the balance and the account shows 0 spent, where do I
/// see that I spent this money?"). Presentation only: every figure comes from
/// the lines as they are; nothing here changes a total.
export interface WalletDetailView {
	account: { id: string; name: string; institution: string; told_only: boolean; takes_sms: boolean };
	since: string;
	/// The shop's credit left (its own unit — must match the shop's figure).
	balance: Money;
	/// What that credit is worth in money (SGD), lot by lot: prepaid, not used yet.
	remaining_value: Money;
	/// Of remaining_value, the part already counted as spending at old top-ups (money).
	precounted_left: Money;
	precounted_category: string | null;
	/// Any lot whose credit differs from what was paid (a shop's bonus).
	bonus: boolean;
	/// Every lot, oldest first: the opening balance, each top-up, any other money in.
	lots: WalletLotView[];
	/// Every use (money out), newest first, at most WALLET_USES_SHOWN; uses_count = all of them.
	uses: WalletUseView[];
	uses_count: number;
	/// The money spent from it since the cut-over: credit used, its real cost, and the
	/// part of that cost already counted at old top-ups (offset, so not counted twice).
	used: { credit: string; cost: Money; precounted: Money; counted_now: Money };
	/// The top-ups BEFORE the cut-over that the ledger holds (newest first, at most 6):
	/// they were counted as spending then — where the pre-counted balance's money went.
	precounted_topups: { line_id: string; date: string; account: string; paid: Money }[];
	/// The story in the owner's words, sentence by sentence.
	story: string[];
	/// The sentence of it about the balance the wallet started with (already counted
	/// as spending at old top-ups), shown on its own above the tabs; null when none.
	opening_story: string | null;
}

export interface WalletLotView {
	kind: "opening" | "topup" | "other";
	line_id: string | null;
	date: string;
	from: { id: string; name: string } | null;
	paid: Money; // SGD
	credit: string;
	used: string;
	left: string;
	value_left: Money; // SGD
	/// The opening balance of a wallet whose old top-ups were counted as spending.
	precounted: boolean;
}

export interface WalletUseView {
	line_id: string;
	date: string;
	kind: LineKind;
	merchant: string | null;
	category: string | null;
	credit: string; // the shop's credit it used
	cost: Money; // its real cost (SGD) — what counts as spending
	/// The part of cost paid with balance already counted at old top-ups (its offset line), else null.
	precounted: Money | null;
	needs_review: boolean;
}

export const WALLET_USES_SHOWN = 100;
/// How far back the ledger looks for the top-ups a pre-counted balance came from.
const PRECOUNTED_LOOKBACK_DAYS = 400;

const md = sayDayMonth;

/// Every active wallet, as walletDetail (the page's GET /api/wallets): 1 + 3 queries a wallet.
export async function walletDetails(db: Db): Promise<WalletDetailView[]> {
	const accounts = await loadAccountMap(db);
	// Every wallet at once, in the accounts' order (20 Oct 2026).
	const views = await Promise.all([...accounts.values()].filter((a) => isWallet(a) && a.active === 1).map((a) => walletDetail(db, a.id, accounts)));
	return views.filter((v): v is WalletDetailView => !!v);
}

export async function walletDetail(db: Db, accountId: string, known?: ReadonlyMap<string, Account>): Promise<WalletDetailView | null> {
	const accounts = known ?? (await loadAccountMap(db));
	const w = accounts.get(accountId);
	if (!isWallet(w)) return null;
	const pre = w.wallet_precounted_minor ?? 0;
	// Its lines, its balance and (pre-counted only) where that money went: one round trip.
	const [rows, states, history] = await Promise.all([
		db
			.prepare("SELECT * FROM lines WHERE account_id = ? AND state <> 'void' AND merged_into IS NULL AND txn_date >= ? ORDER BY txn_date, created_at, id")
			.bind(w.id, w.wallet_since)
			.all<LineRow>()
			.then((r) => r.results),
		walletStates(db, [w]),
		pre > 0 ? precountedTopUps(db, w, accounts) : Promise.resolve([] as WalletDetailView["precounted_topups"]),
	]);
	const opening = w.wallet_opening_minor ?? 0;
	const openingPaid = w.wallet_opening_paid_minor ?? null;
	const { lots } = walkLots(opening, openingPaid, w.wallet_since, rows);
	const byId = new Map(rows.map((l) => [l.id, l]));
	const lotViews: WalletLotView[] = lots.map((lot) => {
		const l = lot.line_id ? byId.get(lot.line_id) ?? null : null;
		const from = l?.counter_account_id ? accounts.get(l.counter_account_id) ?? null : null;
		return {
			kind: !l ? "opening" : l.kind === "transfer" ? "topup" : "other",
			line_id: lot.line_id,
			date: lot.date,
			from: from ? { id: from.id, name: from.name } : null,
			paid: homeMoney(lot.paid),
			credit: creditText(lot.credit),
			used: creditText(lot.used),
			left: creditText(lot.credit - lot.used),
			value_left: homeMoney(lotValueLeft(lot)),
			precounted: !l && pre > 0,
		};
	});
	const offsetOf = new Map(rows.filter((l) => l.kind === "wallet_offset" && l.offset_of).map((l) => [l.offset_of!, -l.home_minor]));
	const outs = rows.filter((l) => l.kind !== "wallet_offset" && l.bill_minor > 0);
	const uses: WalletUseView[] = outs
		.slice()
		.reverse()
		.slice(0, WALLET_USES_SHOWN)
		.map((l) => ({
			line_id: l.id,
			date: l.txn_date,
			kind: l.kind,
			merchant: l.merchant_name ?? l.merchant_raw,
			category: l.category,
			credit: creditText(l.bill_minor),
			cost: homeMoney(l.home_minor),
			precounted: offsetOf.has(l.id) ? homeMoney(offsetOf.get(l.id)!) : null,
			needs_review: l.state === "review",
		}));
	const spent = outs.filter((l) => l.kind === "purchase" || l.kind === "fee");
	const usedCredit = outs.reduce((s, l) => s + l.bill_minor, 0);
	const cost = spent.reduce((s, l) => s + l.home_minor, 0);
	const offset = rows.filter((l) => l.kind === "wallet_offset").reduce((s, l) => s - l.home_minor, 0);
	const state = states.get(w.id)!;
	const balance = state.balance;
	const value = state.remaining_value;
	const bonus = lots.some((x) => x.credit !== x.paid);
	const story: string[] = [];
	story.push(say(bonus ? "wallet.story_balance_bonus" : "wallet.story_balance", { balance: creditText(balance.minor), value: sd(value.minor) }));
	let openingStory: string | null = null;
	if (pre > 0) {
		const when = history.length ? sayList([...history].reverse().map((h) => md(h.date))) : null;
		openingStory = when
			? say("wallet.story_opening_when", { day: md(w.wallet_since), opening: creditText(opening), when })
			: say("wallet.story_opening", { day: md(w.wallet_since), opening: creditText(opening), since: w.wallet_since });
		story.push(openingStory);
		if (state.precounted_left.minor > 0) story.push(say("wallet.story_left", { amount: sd(state.precounted_left.minor) }));
	}
	if (lotViews.some((x) => x.kind === "topup")) story.push(say("wallet.story_topups"));
	if (toldOnly(w) && !takesSms(w)) story.push(say("wallet.story_told"));
	return {
		account: { id: w.id, name: w.name, institution: w.institution, told_only: toldOnly(w), takes_sms: takesSms(w) },
		since: w.wallet_since,
		balance,
		remaining_value: value,
		precounted_left: state.precounted_left,
		precounted_category: w.wallet_precounted_category ?? null,
		bonus,
		lots: lotViews,
		uses,
		uses_count: outs.length,
		used: { credit: creditText(usedCredit), cost: homeMoney(cost), precounted: homeMoney(offset), counted_now: homeMoney(cost - offset) },
		precounted_topups: history,
		story: story,
		opening_story: openingStory,
	};
}

/// The top-ups before a wallet's cut-over that the ledger holds — card or bank
/// lines its own top-up rule would have taken, had the wallet been recorded
/// then. They stay spending (the owner); listed only to say where the money went.
async function precountedTopUps(db: Db, w: WalletAccount, accounts: ReadonlyMap<string, Account>): Promise<WalletDetailView["precounted_topups"]> {
	const words = w.institution === GRAB ? ["GRAB"] : (w.wallet_topup_merchant ?? "").split(/[,，、]/).map((m) => m.trim()).filter(Boolean);
	const likes = words.map((m) => `%${m.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean).join("%")}%`).filter((x) => x !== "%%");
	if (!likes.length) return [];
	const rows = (
		await db
			.prepare(
				`SELECT l.id, l.account_id, l.txn_date, l.merchant_raw, l.bill_minor, l.home_minor FROM lines l JOIN accounts a ON a.id = l.account_id ` +
					`WHERE a.kind IN ('bank', 'debit_card', 'credit_card') AND l.state <> 'void' AND l.merged_into IS NULL AND l.kind = 'purchase' AND l.bill_minor > 0 ` +
					`AND l.txn_date < ? AND l.txn_date >= ? AND (${likes.map(() => "l.merchant_raw LIKE ?").join(" OR ")}) ORDER BY l.txn_date DESC, l.id LIMIT 50`,
			)
			.bind(w.wallet_since, addDays(w.wallet_since, -PRECOUNTED_LOOKBACK_DAYS), ...likes)
			.all<{ id: string; account_id: string; txn_date: string; merchant_raw: string | null; bill_minor: number; home_minor: number }>()
	).results;
	const then = { ...w, wallet_since: "0000-01-01" };
	return rows
		.filter((r) => {
			const a = accounts.get(r.account_id);
			if (!a) return false;
			return w.institution === GRAB ? looksLikeTopUp(a, r.merchant_raw, r.bill_minor, r.txn_date, then) : fitsTopUpRule(a, r.merchant_raw, r.bill_minor, r.txn_date, then);
		})
		.slice(0, 6)
		.map((r) => ({ line_id: r.id, date: r.txn_date, account: accounts.get(r.account_id)!.name, paid: homeMoney(r.home_minor) }));
}
