/// What the page's API and the claude.ai connector can DO, in one place, so the
/// two doors can never disagree about a rule. Each operation validates its
/// input (a Refused says why not), reads through src/queries.ts, writes only
/// through src/engine.ts, and returns §5 shapes from src/views.ts.
///
/// The page routes (src/api.ts) and the five tools (src/mcp.ts) are thin
/// wrappers over these.

import { say } from "../../src/words";
import { homeCurrency, homeMoney } from "../../src/home";
import { addCash, addReimburseRange, changeLine, correctHome, createTrip, editTrip, getLine, markLineSubscription, markWalletTopUp, setTopUpCredit, removeReimburseRange, setIncomeOffset, setLineCategory, setLineKind, setPayeeRule, writeChanges, type IncomeOffset, setReimbursable, setSubscriptionStatus, setTripStatus, type Engine } from "../../src/engine";
import { emptyPlaybook } from "../../src/playbook";
import { markBillPaid, paymentsView, setAutopay, type CardPayment, type PaymentsView } from "../../src/payments";
import type { Db } from "../../src/db";
import { money, type Money } from "../../src/money";
import { publishPlaybook, readHead } from "../../src/playbook-store";
import {
	countFor,
	coverageFor,
	groupTotalsFor,
	lineViews,
	loadAccountMap,
	loadLines,
	loadRanges,
	loadTrip,
	loadTrips,
	oneTripView,
	subscriptionsView,
	todayLocal,
	totalsFor,
	tripBookingLineIds,
	tripMembers,
	tripViews,
	viewContext,
	LINE_FLAGS,
	type GroupBy,
	type GroupTotal,
	type LineFilter,
	type LineOrder,
	type SubscriptionsView,
} from "../../src/queries";
import { Refused } from "../../src/refused";
import { rangeProblem, reimbursable, type ReimburseRange } from "../../src/reimbursable";
import { LINE_KINDS, type Account, type AccountKind, type Actor, type LineKind, type LineRow } from "../../src/types";
import type { LineFlag, LineView, SubscriptionView, Totals, TripView } from "../../src/views";
import { isTransferLine, ownerKind, type OwnerKind } from "../../src/payees";
import { SUBSCRIPTION_CADENCES, type Cadence } from "../../src/subscriptions";
import type { Coverage } from "../../src/coverage";
import { categoryList, isPerson, OWNER_CATEGORIES_KEY } from "./categorise";
import { addCategory, CATEGORY_LIST_KEY, deleteCategory, renameCategory, storedCategories } from "./categories";
import { creditText, GRAB } from "../../src/wallet";
import { answerSmsCheck, dismissSms } from "../../src/wallet-sms";
import type { Deps, LedgerEnv } from "./env";
import { amount, currency, idList, isoDate, oneOf, optBool, optInt, optIsoDate, optOneOf, optText, text } from "./validate";

export interface Op {
	db: Db;
	/// The worker's settings, for the page's status (which Gmail is connected). Never sent anywhere.
	env?: LedgerEnv;
	engine: Engine;
	today: string; // the owner's day (src/home.ts)
	categories: string[]; // the owner's list (LEDGER_CATEGORIES + the ones he added, or the stored list); empty = categories off
	categoryWas: Record<string, string>; // a renamed category → the name it started as (for its icon)
	categoryMoved: Record<string, string | null>; // an old category name (lower case) → where it went (src/categories.ts)
}

/// The engine as the given actor, with the playbook's own names and merchant
/// aliases (none before the senior model writes the first playbook).
export async function makeOp(env: LedgerEnv, deps: Deps, actor: Actor): Promise<Op> {
	// Both in one round trip: every request the page makes starts here (20 Oct 2026).
	// Each read is its own async call, so a database that throws at once fails the request, not as a stray rejection.
	const readLists = async () => (await env.LEDGER_DB.prepare("SELECT key, value FROM sync_state WHERE key IN (?, ?)").bind(OWNER_CATEGORIES_KEY, CATEGORY_LIST_KEY).all<{ key: string; value: string }>()).results;
	const [head, lists] = await Promise.all([readHead(env.LEDGER_DB), readLists()]);
	const added = lists.find((r) => r.key === OWNER_CATEGORIES_KEY);
	const stored = storedCategories(safeJson(lists.find((r) => r.key === CATEGORY_LIST_KEY)?.value ?? "null"));
	return {
		db: env.LEDGER_DB,
		env,
		today: todayLocal(deps.now()),
		categories: categoryList(env, added ? safeJson(added.value) : [], stored),
		categoryWas: stored?.was ?? {},
		categoryMoved: stored?.moved ?? {},
		engine: {
			db: env.LEDGER_DB,
			now: () => deps.now().toISOString(),
			newId: () => deps.newId(),
			ownNames: head?.body.own_names ?? [],
			aliases: head?.body.merchant_aliases ?? [],
			actor,
		},
	};
}

// ------------------------------------------------------------------ resolving names

/// An account by its id, or by a piece of its name ("HSBC", "台新", "5507").
/// More than one match is refused with the candidates, never guessed.
export async function resolveAccount(db: Db, value: string, known?: Promise<ReadonlyMap<string, Account>>): Promise<Account> {
	const accounts = [...(await (known ?? loadAccountMap(db))).values()];
	const exact = accounts.find((a) => a.id === value);
	if (exact) return exact;
	const needle = value.trim().toLowerCase();
	// "grabpay" / "GrabPay" / "grab pay" name the Grab wallet, whatever its id or name;
	// "sample bistro" / "samplebistro" / "Sample-Bistro" name that wallet by its id.
	const squeezed = (x: string) => x.toLowerCase().replace(/[\s_-]+/g, "");
	const walletWord = (a: Account) => a.kind === "wallet" && [`${squeezed(a.institution)}pay`, squeezed(a.id), squeezed(a.institution)].includes(squeezed(needle));
	const hits = accounts.filter((a) => a.name.toLowerCase().includes(needle) || a.institution.toLowerCase() === needle || walletWord(a));
	if (hits.length === 1) return hits[0]!;
	const list = (as: Account[]) => as.map((a) => `${a.name} (${a.id})`).join("; ");
	if (!hits.length) throw new Refused(`no account matches "${value}". The accounts are: ${list(accounts)}`);
	throw new Refused(`"${value}" matches more than one account: ${list(hits)}`);
}

/// A trip by its id, or by a piece of its name or destination.
export async function resolveTripId(db: Db, value: string): Promise<string> {
	if (await loadTrip(db, value)) return value;
	const needle = value.trim().toLowerCase();
	const trips = await loadTrips(db);
	const hits = trips.filter((t) => (t.name ?? "").toLowerCase().includes(needle) || t.destination.toLowerCase().includes(needle));
	const live = hits.filter((t) => t.status !== "dismissed");
	const pick = live.length ? live : hits;
	if (pick.length === 1) return pick[0]!.id;
	const list = (ts: typeof trips) => ts.map((t) => `${t.name ?? t.destination} ${t.start_date}→${t.end_date} [${t.status}] (${t.id})`).join("; ");
	if (!pick.length) throw new Refused(`no trip matches "${value}"${trips.length ? `. The trips are: ${list(trips)}` : "; there are no trips yet"}`);
	throw new Refused(`"${value}" matches more than one trip: ${list(pick)}`);
}

// ------------------------------------------------------------------ ledger_query

export const GROUP_BYS = ["none", "category", "merchant", "account", "month"] as const;
export const SORTS: readonly LineOrder[] = ["amount", "date"];
export const QUERY_DEFAULT_LIMIT = 50;
export const QUERY_MAX_LIMIT = 200;

export interface QueryResult {
	period: { from: string; to: string };
	lines: LineView[];
	totals: Totals;
	/// The total split: the part that is an exact figure, and the part that is
	/// still an estimate (foreign charges before their statement, 台新 and
	/// foreign cash at the reference rate).
	split: { confirmed_home: Money; estimate_home: Money };
	groups?: GroupTotal[];
	coverage: Coverage[];
	matched: number;
	truncated: boolean;
}

export async function queryOp(op: Op, input: Record<string, unknown>): Promise<QueryResult> {
	const givenTo = optIsoDate(input.to, "to");
	const givenFrom = optIsoDate(input.from, "from");
	const to = givenTo ?? op.today;
	const from = givenFrom ?? `${to.slice(0, 7)}-01`;
	if (from > to) throw new Refused(`the period ends (${to}) before it starts (${from})`);
	const accountValue = optText(input.account_id ?? input.account, "account_id", 120);
	const account = accountValue ? await resolveAccount(op.db, accountValue) : null;
	const tripValue = optText(input.trip_id ?? input.trip, "trip_id", 120);
	let lineIds: string[] | null = null;
	if (tripValue) {
		const trip = (await loadTrip(op.db, await resolveTripId(op.db, tripValue)))!;
		lineIds = (await tripMembers(op.db, trip)).map((l) => l.id);
	}
	const flags = input.flags === undefined || input.flags === null ? null : (Array.isArray(input.flags) ? input.flags : [input.flags]).map((f) => oneOf(f, LINE_FLAGS, "flags"));
	const filter: LineFilter = {
		from,
		to,
		account_id: account?.id ?? null,
		kind: optOneOf(input.kind, LINE_KINDS, "kind") as LineKind | null,
		category: optText(input.category, "category", 80),
		merchant: optText(input.merchant, "merchant", 200),
		line_ids: lineIds,
		reimbursable: optBool(input.reimbursable, "reimbursable"),
		flags: flags as LineFlag[] | null,
		provisional: optBool(input.provisional, "provisional"),
	};
	const groupBy = optOneOf(input.group_by, GROUP_BYS, "group_by") ?? "none";
	const sort = optOneOf(input.sort, SORTS, "sort") ?? "amount";
	const limit = optInt(input.limit, "limit", 1, QUERY_MAX_LIMIT) ?? QUERY_DEFAULT_LIMIT;

	// Added up and counted by the database; only the top lines are loaded, so
	// "everything in the last two years" costs the same few queries as a week.
	const top = await loadLines(op.db, filter, sort, limit);
	const ctx = await viewContext(op.db);
	const t = await totalsFor(op.db, filter);
	const matched = await countFor(op.db, filter);
	const asOf = to < op.today ? to : op.today;
	return {
		period: { from, to },
		lines: await lineViews(op.db, top, ctx),
		totals: t,
		split: { confirmed_home: homeMoney(t.spending_home.minor - t.unconfirmed_home.minor), estimate_home: t.unconfirmed_home },
		...(groupBy !== "none" ? { groups: await groupTotalsFor(op.db, filter, groupBy as GroupBy, ctx.accounts) } : {}),
		coverage: await coverageFor(op.db, account ? [account] : ctx.accounts.values(), asOf),
		matched,
		truncated: matched > top.length,
	};
}

// ------------------------------------------------------------------ cash

export async function lineViewById(op: Op, lineId: string): Promise<LineView> {
	const rows = await loadLines(op.db, { line_ids: [lineId] });
	if (!rows.length) throw new Refused("no such line");
	return (await lineViews(op.db, rows))[0]!;
}

/// Add cash the owner spent, or correct the home-currency figure of a cash / reference line.
export async function cashOp(op: Op, input: Record<string, unknown>): Promise<{ line: LineView; already_recorded?: boolean }> {
	if (input.line_id !== undefined && input.line_id !== null && input.line_id !== "") {
		const id = text(input.line_id, "line_id", 120);
		const home = amount(input.home_amount, homeCurrency(), "home_amount");
		await correctHome(op.engine, id, home);
		return { line: await lineViewById(op, id) };
	}
	const date = optIsoDate(input.date, "date") ?? op.today;
	if (date > op.today) throw new Refused(`the date ${date} is in the future`);
	// Where the money came from: cash (default), a wallet — "grabpay", "GrabPay", "grab",
	// "sample-bistro", "Sample Bistro" (any prepaid wallet the owner declared) — or a card
	// ("citi", a card's id): a purchase no alert or tap brought, which its statement joins.
	const accountText = optText(input.account ?? input.account_id, "account", 80);
	const from = accountText ? await resolveAccount(op.db, accountText) : null;
	if (from?.kind === "bank") throw new Refused(`${from.name} is a bank account: its lines come from its alerts and statements. Only cash, one of your wallets (GrabPay, a prepaid card) or a card can be added by hand`);
	const onCard = from?.kind === "credit_card" || from?.kind === "debit_card";
	// No category named: the wallet's own default (Sample Bistro: Food), only when it is on the owner's list.
	const named = optText(input.category, "category", 80);
	const fallback = from?.kind === "wallet" && from.wallet_spend_category ? (op.categories.find((c) => c.toLowerCase() === from.wallet_spend_category!.toLowerCase()) ?? null) : null;
	// No currency named: a wallet's or card's own (a 台新 card's TWD), else the home currency.
	const cur = input.currency === undefined || input.currency === null || input.currency === "" ? (from?.kind === "wallet" || onCard ? from!.currency : currency(input.currency)) : currency(input.currency);
	const minor = amount(input.amount, cur, "amount");
	if (minor === 0) throw new Refused("amount must not be zero");
	const homeGiven = input.home_amount === undefined || input.home_amount === null || input.home_amount === "" ? null : amount(input.home_amount, homeCurrency(), "home_amount");
	const line = await addCash(op.engine, {
		txn_date: date,
		currency: cur,
		amount_minor: minor,
		merchant: text(input.merchant, "merchant", 120),
		category: named ?? (minor > 0 ? fallback : null),
		note: optText(input.note, "note", 500),
		home_minor: homeGiven,
		account_id: from?.id ?? null,
	});
	// A wallet purchase Grab's own email (or the shop's SMS) had already recorded, or a card
	// purchase its alert, tap or statement had: the owner's word joined that line.
	return { line: await lineViewById(op, line.id), ...(from?.kind === "wallet" || onCard ? { already_recorded: line.created_by !== "owner" } : {}) };
}

// ------------------------------------------------------------------ reimbursable

export interface ReimbursableResult {
	ranges: ReimburseRange[];
	affected_lines: number;
	reimbursable_total_home: Money;
}

/// Effective reimbursable status of every line in a scope, before and after a
/// change: "affected" is how many changed, the total is what is claimable in
/// that scope afterwards.
async function reimbursableIn(op: Op, scope: LineFilter): Promise<Map<string, { yes: boolean; home: number }>> {
	const ranges = await loadRanges(op.db);
	return new Map((await loadLines(op.db, scope)).map((l) => [l.id, { yes: reimbursable(l, ranges).effective, home: l.home_minor }]));
}

async function measured(op: Op, scope: LineFilter, change: () => Promise<void>): Promise<ReimbursableResult> {
	const before = await reimbursableIn(op, scope);
	await change();
	const after = await reimbursableIn(op, scope);
	let affected = 0;
	let total = 0;
	for (const [id, a] of after) {
		if ((before.get(id)?.yes ?? false) !== a.yes) affected++;
		if (a.yes) total += a.home;
	}
	return { ranges: await loadRanges(op.db), affected_lines: affected, reimbursable_total_home: homeMoney(total) };
}

/// The same dates twice is one range, not two.
async function ensureRange(op: Op, from: string, to: string, note: string | null): Promise<string> {
	const existing = (await loadRanges(op.db)).find((r) => r.start_date === from && r.end_date === to);
	return existing ? existing.id : addReimburseRange(op.engine, from, to, note);
}

export function rangeInput(input: Record<string, unknown>): { from: string; to: string; note: string | null } {
	const from = isoDate(input.from ?? input.start_date, "from");
	const to = isoDate(input.to ?? input.end_date, "to");
	const problem = rangeProblem(from, to);
	if (problem) throw new Refused(problem);
	return { from, to, note: optText(input.note, "note", 200) };
}

export async function addRangeOp(op: Op, input: Record<string, unknown>): Promise<{ range: ReimburseRange; count: number; result: ReimbursableResult }> {
	const r = rangeInput(input);
	let id = "";
	const result = await measured(op, { from: r.from, to: r.to }, async () => {
		id = await ensureRange(op, r.from, r.to, r.note);
	});
	const ranges = await loadRanges(op.db);
	const range = ranges.find((x) => x.id === id)!;
	const covered = [...(await reimbursableIn(op, { from: r.from, to: r.to })).values()].filter((x) => x.yes).length;
	return { range, count: covered, result };
}

export async function setLineReimbursableOp(op: Op, lineId: string, value: unknown): Promise<ReimbursableResult> {
	if (value !== true && value !== false && value !== null) throw new Refused("reimbursable must be true, false, or null (null clears your override)");
	return measured(op, { line_ids: [lineId] }, async () => {
		await setReimbursable(op.engine, lineId, value === null ? null : value ? 1 : 0);
	});
}

export async function removeRangeOp(op: Op, rangeId: string): Promise<ReimbursableResult> {
	const range = (await loadRanges(op.db)).find((r) => r.id === rangeId);
	if (!range) throw new Refused("no such reimbursable range");
	return measured(op, { from: range.start_date, to: range.end_date }, () => removeReimburseRange(op.engine, rangeId));
}

/// A trip's dates become a range, and its bookings (paid weeks before) are
/// marked reimbursable one by one.
export async function tripReimbursableOp(op: Op, tripValue: string): Promise<ReimbursableResult> {
	const trip = (await loadTrip(op.db, await resolveTripId(op.db, tripValue)))!;
	if (trip.status === "dismissed") throw new Refused("that trip was dismissed; restore it first");
	const bookings = await tripBookingLineIds(op.db, trip);
	const inDates = (await loadLines(op.db, { from: trip.start_date, to: trip.end_date })).map((l) => l.id);
	return measured(op, { line_ids: [...new Set([...inDates, ...bookings])] }, async () => {
		await ensureRange(op, trip.start_date, trip.end_date, trip.name ?? trip.destination);
		for (const id of bookings) await setReimbursable(op.engine, id, 1);
	});
}

/// ledger_mark_reimbursable: exactly one of range / remove_range_id / line_id / trip_id.
export async function markReimbursableOp(op: Op, input: Record<string, unknown>): Promise<ReimbursableResult> {
	const given = (["range", "remove_range_id", "line_id", "trip_id"] as const).filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== "");
	if (given.length !== 1) throw new Refused("give exactly one of: range {from, to, note}, remove_range_id, line_id (with reimbursable), or trip_id");
	switch (given[0]!) {
		case "range": {
			if (typeof input.range !== "object" || input.range === null) throw new Refused("range must be {from, to, note}");
			return (await addRangeOp(op, input.range as Record<string, unknown>)).result;
		}
		case "remove_range_id":
			return removeRangeOp(op, text(input.remove_range_id, "remove_range_id", 120));
		case "line_id":
			if (!("reimbursable" in input)) throw new Refused("say reimbursable: true, false, or null (null clears your override)");
			return setLineReimbursableOp(op, text(input.line_id, "line_id", 120), input.reimbursable);
		case "trip_id":
			return tripReimbursableOp(op, text(input.trip_id, "trip_id", 120));
	}
}

// ------------------------------------------------------------------ trips

export const TRIP_ACTIONS = ["list", "create", "confirm", "dismiss", "restore", "edit"] as const;

export async function tripResult(op: Op, tripId: string): Promise<{ trip: TripView; lines: LineView[] }> {
	const found = await oneTripView(op.db, tripId);
	if (!found) throw new Refused("no such trip");
	return { trip: found.trip, lines: await lineViews(op.db, found.members) };
}

export async function tripOp(op: Op, input: Record<string, unknown>): Promise<{ trips: TripView[] } | { trip: TripView; lines: LineView[] }> {
	const action = oneOf(input.action ?? "list", TRIP_ACTIONS, "action");
	if (action === "list") return { trips: await tripViews(op.db, ["proposed", "confirmed"]) };
	if (action === "create") {
		// The owner's own trip: confirmed at once; then the same edits as any trip.
		const id = await createTrip(op.engine, {
			name: text(input.name, "name", 120),
			start_date: isoDate(input.start_date, "start_date"),
			end_date: isoDate(input.end_date, "end_date"),
			destination: optText(input.destination, "destination", 120),
		});
		const include = idList(input.include_line_ids, "include_line_ids");
		const exclude = idList(input.exclude_line_ids, "exclude_line_ids");
		if (include.length || exclude.length) await editTrip(op.engine, id, { include_line_ids: include, exclude_line_ids: exclude });
		return tripResult(op, id);
	}
	const tripId = await resolveTripId(op.db, text(input.trip_id ?? input.trip, "trip_id", 120));
	const edit = {
		...(input.name !== undefined ? { name: input.name === null ? null : text(input.name, "name", 120) } : {}),
		...(input.start_date !== undefined ? { start_date: isoDate(input.start_date, "start_date") } : {}),
		...(input.end_date !== undefined ? { end_date: isoDate(input.end_date, "end_date") } : {}),
		include_line_ids: idList(input.include_line_ids, "include_line_ids"),
		exclude_line_ids: idList(input.exclude_line_ids, "exclude_line_ids"),
	};
	const editing = Object.keys(edit).length > 2 || edit.include_line_ids.length > 0 || edit.exclude_line_ids.length > 0;
	if (editing && (action === "dismiss" || action === "restore")) throw new Refused(`changes to a trip go with action "edit" or "confirm", not "${action}"`);
	if (action === "confirm") {
		// Corrections and the confirmation land in ONE write (editTrip's confirm).
		if (editing) await editTrip(op.engine, tripId, { ...edit, confirm: true });
		else await setTripStatus(op.engine, tripId, "confirm");
	} else if (action === "edit") {
		if (!editing) throw new Refused("nothing to change: give name, start_date, end_date, include_line_ids or exclude_line_ids");
		await editTrip(op.engine, tripId, edit);
	} else {
		await setTripStatus(op.engine, tripId, action);
	}
	return tripResult(op, tripId);
}

// ------------------------------------------------------------------ subscriptions

export const SUBSCRIPTION_ACTIONS = ["ignore", "cancelled", "active", "restore"] as const;

async function resolveSubscriptionId(db: Db, value: string): Promise<string> {
	const rows = (await db.prepare("SELECT id, merchant_key, merchant_name, cadence FROM subscriptions").bind().all<{ id: string; merchant_key: string; merchant_name: string | null; cadence: string }>()).results;
	if (rows.some((r) => r.id === value)) return value;
	const needle = value.trim().toLowerCase();
	const hits = rows.filter((r) => (r.merchant_name ?? r.merchant_key).toLowerCase().includes(needle) || r.merchant_key.toLowerCase().includes(needle));
	if (hits.length === 1) return hits[0]!.id;
	if (!hits.length) throw new Refused(`no subscription matches "${value}"`);
	throw new Refused(`"${value}" matches more than one subscription: ${hits.map((h) => `${h.merchant_name ?? h.merchant_key} ${h.cadence} (${h.id})`).join("; ")}`);
}

export async function subscriptionsOp(op: Op, input: Record<string, unknown>): Promise<SubscriptionsView> {
	const which = optOneOf(input.status, ["active", "all"] as const, "status") ?? "active";
	const action = optOneOf(input.action, SUBSCRIPTION_ACTIONS, "action");
	if (action) {
		const id = await resolveSubscriptionId(op.db, text(input.subscription_id ?? input.subscription, "subscription_id", 120));
		await setSubscriptionStatus(op.engine, id, action);
	} else if (input.subscription_id) {
		throw new Refused('say what to do with it: action "ignore", "cancelled", "active" (still running) or "restore"');
	}
	return subscriptionsView(op.db, which);
}

// ------------------------------------------------------------------ categories

export interface CategoryResult {
	categories: string[];
	/// For a merchant: its lines (they move into the category within a minute).
	changed: { merchant_key: string; name: string | null; category: string; lines: number }[];
	line?: LineView;
}

/// The most merchants one "merchant" phrase may change at once: past this the
/// phrase is too vague and the owner is asked to be more specific.
const MAX_MERCHANTS = 15;

/// The owner's word on a category: one line (line_id), or every line of the
/// merchants whose name contains `merchant` — that becomes a rule of his,
/// which no model replaces. With neither, it lists his categories.
export async function setCategoryOp(op: Op, input: Record<string, unknown>): Promise<CategoryResult> {
	const categories = op.categories;
	if (!categories.length) throw new Refused("no category list is set (LEDGER_CATEGORIES)");
	const lineId = optText(input.line_id, "line_id", 120);
	const phrase = optText(input.merchant, "merchant", 80);
	if (!lineId && !phrase) return { categories, changed: [] };
	if (lineId && phrase) throw new Refused("give line_id or merchant, not both");
	const asked = text(input.category, "category", 80);
	const category = categories.find((c) => c.toLowerCase() === asked.toLowerCase());
	if (!category) throw new Refused(`'${asked}' is not one of your categories: ${categories.join(", ")}`);
	if (lineId) {
		const line = await setLineCategory(op.engine, lineId, category);
		return { categories, changed: [{ merchant_key: line.merchant_key ?? "", name: line.merchant_name, category, lines: 1 }], line: await lineViewById(op, line.id) };
	}
	const like = `%${phrase!.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
	const found = (
		await op.db
			.prepare("SELECT merchant_key, MAX(merchant_name) AS name, COUNT(*) AS n FROM lines WHERE merchant_key IS NOT NULL AND (merchant_key LIKE ? ESCAPE '\\' OR merchant_name LIKE ? ESCAPE '\\' OR merchant_raw LIKE ? ESCAPE '\\') GROUP BY merchant_key ORDER BY n DESC LIMIT ?")
			.bind(like, like, like, MAX_MERCHANTS + 1)
			.all<{ merchant_key: string; name: string | null; n: number }>()
	).results;
	if (!found.length) throw new Refused(`no merchant in the ledger matches '${phrase}'`);
	if (found.length > MAX_MERCHANTS) throw new Refused(`'${phrase}' matches more than ${MAX_MERCHANTS} merchants; say it more exactly (for example the name as it appears on the statement)`);
	for (let attempt = 0; ; attempt++) {
		const head = await readHead(op.db);
		const book = head?.body ?? emptyPlaybook();
		const keys = new Set(found.map((f) => f.merchant_key));
		const next = {
			...book,
			categories: book.categories.includes(category) ? book.categories : [...book.categories, category],
			category_rules: [...book.category_rules.filter((r) => !keys.has(r.merchant_key)), ...found.map((f) => ({ merchant_key: f.merchant_key, category, by: "owner" as const }))],
		};
		const pub = await publishPlaybook(op.db, next, head?.version ?? null, "owner", `the owner: ${phrase} → ${category}`, op.engine.now());
		if (pub.ok) break;
		if (pub.reason !== "conflict" || attempt >= 2) throw new Refused("the ledger's rules were being changed at the same moment; try again");
	}
	await syncPayeeCategory(op, found.map((f) => f.merchant_key), category);
	// The lines move within a minute: the tick's categorise step has the query
	// budget for a merchant with years of lines; this call has 40.
	const changed = found.map((f) => ({ merchant_key: f.merchant_key, name: f.name, category, lines: f.n }));
	return { categories, changed };
}

export interface PickResult {
	line: LineView;
	/// "merchant": remembered for this payee (its other lines follow within a
	/// minute, and every future one); "line": this line only.
	scope: "merchant" | "line";
	person: boolean; // the payee is a person (so "auto" kept it to this line)
	merchant_name: string | null;
	others: number; // the payee's other lines that will follow (merchant scope)
	changed: number; // lines whose category changed by this call (this one + the payee's that moved at once)
}

/// Lines of a payee moved at once when the owner picks its category on the page;
/// any beyond follow within a minute (the tick's categorise step).
const PICK_MOVE_NOW = 300;

/// The owner's payee rules (src/payees.ts) that name these merchants follow his new
/// category, so a masked form of the same name lands with them.
async function syncPayeeCategory(op: Op, keys: readonly string[], category: string): Promise<void> {
	if (!keys.length) return;
	await op.db
		.prepare(`UPDATE payee_rules SET category = ?, updated_at = ? WHERE merchant_key IN (SELECT value FROM json_each(?)) AND category IS NOT NULL`)
		.bind(category, op.engine.now(), JSON.stringify(keys))
		.run()
		.catch(() => undefined); // before migration 0006 there is no such table: nothing to keep in step
}

/// The owner picks a category for one line on his page, and the ledger learns:
/// "auto" remembers it for the payee — same shop, same bank, same company
/// will be the same next time — except a payee that is a PERSON, where only
/// this line changes. "merchant" remembers it even for a person (his rent to a
/// landlord); "line" changes this line only.
export async function pickCategoryOp(op: Op, lineId: string, input: Record<string, unknown>): Promise<PickResult> {
	const categories = op.categories;
	if (!categories.length) throw new Refused("no category list is set (LEDGER_CATEGORIES)");
	const asked = text(input.category, "category", 80);
	const category = categories.find((c) => c.toLowerCase() === asked.toLowerCase());
	if (!category) throw new Refused(`'${asked}' is not one of your categories`);
	// The page's 「改分類」 sends apply_to_merchant (true = this payee, before and after; false = this line).
	const apply = optBool(input.apply_to_merchant, "apply_to_merchant");
	const want = optOneOf(input.scope, ["auto", "merchant", "line"] as const, "scope") ?? (apply === true ? "merchant" : apply === false ? "line" : "auto");
	const line = await getLine(op.db, lineId);
	if (!line) throw new Refused("no such line");
	const head = await readHead(op.db);
	const person = isPerson(head?.body, line.merchant_key);
	const scope = !line.merchant_key || want === "line" || (want === "auto" && person) ? "line" : "merchant";
	if (scope === "line") {
		const changed = await setLineCategory(op.engine, line.id, category);
		return { line: await lineViewById(op, changed.id), scope, person, merchant_name: line.merchant_name, others: 0, changed: line.category === category ? 0 : 1 };
	}
	for (let attempt = 0; ; attempt++) {
		const h = attempt === 0 ? head : await readHead(op.db);
		const book = h?.body ?? emptyPlaybook();
		const next = {
			...book,
			categories: book.categories.includes(category) ? book.categories : [...book.categories, category],
			category_rules: [...book.category_rules.filter((r) => r.merchant_key !== line.merchant_key), { merchant_key: line.merchant_key!, category, by: "owner" as const }],
		};
		const pub = await publishPlaybook(op.db, next, h?.version ?? null, "owner", `the owner: ${line.merchant_name ?? line.merchant_key} → ${category}`, op.engine.now());
		if (pub.ok) break;
		if (pub.reason !== "conflict" || attempt >= 2) throw new Refused("the ledger's rules were being changed at the same moment; try again");
	}
	// This line moves now, following the rule (so a later change of the rule moves it too);
	// the payee's other lines follow within a minute (the tick's categorise step).
	const moved = await changeLine({ ...op.engine, actor: "owner" }, line, { category }, "categorise");
	await syncPayeeCategory(op, [line.merchant_key!], category);
	// Round 2: the payee's other lines move now too (the page reloads to show
	// them), in two writes however many — except a line the owner set one by one.
	const follow = (
		await op.db
			.prepare("SELECT * FROM lines l WHERE merchant_key = ? AND id <> ? AND state <> 'void' AND (category IS NULL OR category <> ?) AND NOT EXISTS (SELECT 1 FROM line_events v WHERE v.line_id = l.id AND v.actor = 'owner' AND v.event = 'category') LIMIT ?")
			.bind(line.merchant_key, line.id, category, PICK_MOVE_NOW)
			.all<LineRow>()
	).results;
	const followed = await writeChanges({ ...op.engine, actor: "owner" }, "categorise", follow.map((l) => ({ line: l, changes: { category } })));
	const others = await op.db
		.prepare("SELECT COUNT(*) AS n FROM lines WHERE merchant_key = ? AND id <> ? AND state <> 'void' AND (category IS NULL OR category <> ?)")
		.bind(line.merchant_key, line.id, category)
		.first<{ n: number }>();
	return { line: await lineViewById(op, moved.id), scope, person, merchant_name: line.merchant_name, others: others?.n ?? 0, changed: (line.category === category ? 0 : 1) + followed };
}

function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

/// The owner's word on his category list: add one, rename one (everything named it follows) or delete one
/// (moving what uses it to `move_to`) — src/categories.ts. `remove` is the old word for delete.
export async function editCategoriesOp(op: Op, input: Record<string, unknown>): Promise<{ categories: string[]; was: Record<string, string> }> {
	if (input.rename !== undefined) return renameCategory(op, input);
	if (input.delete !== undefined || input.remove !== undefined) return deleteCategory(op, { ...input, delete: input.delete ?? input.remove });
	if (input.add !== undefined && input.add !== null && input.add !== "") await addCategory(op, input.add);
	return { categories: op.categories, was: op.categoryWas };
}

export const OFFSET_TARGETS = ["salary", "card", "line", "none"] as const;

/// The owner says what one incoming payment offsets (salary / a card / one purchase / none).
export async function incomeOffsetOp(op: Op, lineId: string, input: Record<string, unknown>): Promise<{ line: LineView }> {
	const to = oneOf(input.to, OFFSET_TARGETS, "to");
	const offset =
		to === "card"
			? { to, account_id: (await resolveAccount(op.db, text(input.account_id ?? input.account, "account_id", 120))).id }
			: to === "line"
				? { to, line_id: text(input.target_line_id ?? input.purchase_line_id, "target_line_id", 120) }
				: { to };
	const line = await setIncomeOffset(op.engine, lineId, offset as IncomeOffset);
	return { line: await lineViewById(op, line.id) };
}

// ------------------------------------------------------------------ kinds (the owner's payee rules)

const KIND_WORDS = "spending (purchase), investment, loan_repayment, friend_transfer, own_transfer (transfer) or card_payment";

function kindInput(value: unknown): OwnerKind {
	const k = ownerKind(value);
	if (!k) throw new Refused(`kind must be one of: ${KIND_WORDS}`);
	return k;
}

export interface LineKindResult {
	line: LineView;
	scope: "merchant" | "line";
	merchant_name: string | null;
	/// Lines whose kind changed by this call (merchant scope: every line of the payee).
	changed: number;
}

/// The page's 「這筆不算花費」: what one line's money is, for this line only or
/// (apply_to_merchant) for its payee — every line before and after.
export async function lineKindOp(op: Op, lineId: string, input: Record<string, unknown>): Promise<LineKindResult> {
	if (isTopUpKind(input.kind)) {
		// 「儲值到…」: this line only — a payee rule could move a real Grab ride, or a
		// meal paid by card at the same restaurant.
		if (optBool(input.apply_to_merchant, "apply_to_merchant")) throw new Refused("a wallet top-up is set one line at a time");
		const wallet = await topUpTarget(op, input);
		const before = await getLine(op.db, lineId);
		const after = await markWalletTopUp(op.engine, lineId, wallet, creditInput(input.credit));
		return { line: await lineViewById(op, after.id), scope: "line", merchant_name: after.merchant_name, changed: before && before.kind !== after.kind ? 1 : 0 };
	}
	const kind = kindInput(input.kind);
	const apply = optBool(input.apply_to_merchant, "apply_to_merchant") ?? false;
	const line = await getLine(op.db, lineId);
	if (!line) throw new Refused("no such line");
	if (apply) {
		if (!line.merchant_key) throw new Refused("this line has no payee name to remember; change it for this line only");
		// Made from a card line: it covers that card merchant's lines (by exactly its name) too.
		const accountKind = (await op.db.prepare("SELECT kind FROM accounts WHERE id = ?").bind(line.account_id).first<{ kind: AccountKind }>())?.kind;
		const r = await setPayeeRule(op.engine, line.merchant_key, { kind }, { cardLines: !isTransferLine(accountKind, line.merchant_raw, line.kind) });
		return { line: await lineViewById(op, line.id), scope: "merchant", merchant_name: line.merchant_name, changed: r.changed };
	}
	const after = await setLineKind(op.engine, line.id, kind);
	return { line: await lineViewById(op, after.id), scope: "line", merchant_name: line.merchant_name, changed: after.kind === line.kind ? 0 : 1 };
}

/// The owner's word that a bank or card line was money put into one of his wallets
/// (`wallet` names which: "grabpay", "sample-bistro", …).
export const WALLET_TOPUP = "wallet_topup";
/// The older word, kept working: a top-up of his GrabPay wallet.
export const GRABPAY_TOPUP = "grabpay_topup";
const isTopUpKind = (k: unknown): boolean => k === WALLET_TOPUP || k === GRABPAY_TOPUP;

/// The credit a top-up gave (19 Oct 2026, "pay 200, get 240" → "240"): the
/// wallet's own unit, written like home-currency figures (a wallet keeps the home currency). Absent = the shop's usual deal, else none.
function creditInput(v: unknown): number | null {
	if (v === undefined || v === null || v === "") return null;
	const c = amount(v, homeCurrency(), "credit");
	if (c <= 0) throw new Refused("credit must be above zero, e.g. \"240\"");
	return c;
}

/// 待確認 「這次儲值有送嗎？」: the credit a top-up gave (either side's line id),
/// or credit null = no bonus. The wallet's balance and its meals' real cost follow.
export async function topUpCreditOp(op: Op, lineId: string, input: Record<string, unknown>): Promise<{ line: LineView; message: string }> {
	const credit = creditInput(input.credit);
	const leg = await setTopUpCredit(op.engine, lineId, credit);
	const view = await lineViewById(op, leg.id);
	return { line: view, message: credit === null ? say("ops.topup_no_bonus", { name: view.account.name }) : say("ops.topup_bonus", { credit: creditText(-leg.bill_minor) }) };
}

/// 待確認 on a shop's SMS: take its balance (accept), look himself (checked), or record a
/// misread one himself (dismiss).
export async function smsAnswerOp(op: Op, smsId: string, answer: "accept" | "checked" | "dismiss"): Promise<{ message: string; line?: LineView }> {
	if (answer === "dismiss") {
		await dismissSms(op.engine, smsId);
		return { message: say("ops.sms_dismissed") };
	}
	const row = await op.db.prepare("SELECT a.wallet_spend_category AS cat FROM wallet_sms s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?").bind(smsId).first<{ cat: string | null }>();
	const category = row?.cat ? (op.categories.find((c) => c.toLowerCase() === row.cat!.toLowerCase()) ?? null) : null;
	const r = await answerSmsCheck(op.engine, smsId, answer, category);
	return { message: r.message, ...(r.line_id ? { line: await lineViewById(op, r.line_id) } : {}) };
}

/// Which wallet a top-up goes to: `wallet` when given (it must be one of his
/// wallets); `grabpay_topup` alone = GrabPay; `wallet_topup` alone only when he
/// has exactly one wallet — otherwise refused with the list, never guessed.
async function topUpTarget(op: Op, input: Record<string, unknown>): Promise<string | null> {
	const named = optText(input.wallet, "wallet", 80);
	const wallets = [...(await loadAccountMap(op.db)).values()].filter((a) => a.kind === "wallet" && a.active === 1);
	const list = wallets.map((w) => `${w.name} (${w.id})`).join("; ");
	if (named) {
		const w = await resolveAccount(op.db, named);
		if (w.kind !== "wallet") throw new Refused(`${w.name} is not a wallet. Your wallets: ${list || "none"}`);
		if (input.kind === GRABPAY_TOPUP && w.institution !== GRAB) throw new Refused(`grabpay_topup is for GrabPay; for ${w.name} use kind wallet_topup with wallet "${w.id}"`);
		return w.id;
	}
	if (input.kind === GRABPAY_TOPUP) return null;
	if (wallets.length === 1) return wallets[0]!.id;
	throw new Refused(wallets.length ? `say which wallet the money went into (wallet): ${list}` : "there is no wallet on the account list");
}

export interface SetKindResult {
	kinds: readonly string[];
	changed: { merchant_key: string; name: string | null; kind: OwnerKind; lines: number }[];
	line?: LineView;
}

/// The connector's ledger_set_kind: one line (line_id), or every line of the
/// merchants whose name contains `merchant` (at most 15) — that becomes the owner's
/// rule for each, which beats detection and every model, now and later.
export async function setKindOp(op: Op, input: Record<string, unknown>): Promise<SetKindResult> {
	const lineId = optText(input.line_id, "line_id", 120);
	const phrase = optText(input.merchant, "merchant", 80);
	const kinds = ["spending", "investment", "loan_repayment", "friend_transfer", "own_transfer", "card_payment", WALLET_TOPUP, GRABPAY_TOPUP] as const;
	if (!lineId && !phrase) return { kinds, changed: [] };
	if (lineId && phrase) throw new Refused("give line_id or merchant, not both");
	if (isTopUpKind(input.kind)) {
		if (!lineId) throw new Refused("a wallet top-up is set one line at a time: give its line_id");
		const wallet = await topUpTarget(op, input);
		const before = await getLine(op.db, lineId);
		const after = await markWalletTopUp(op.engine, lineId, wallet, creditInput(input.credit));
		return { kinds, changed: [{ merchant_key: after.merchant_key ?? "", name: after.merchant_name, kind: "transfer", lines: before && before.kind !== after.kind ? 1 : 0 }], line: await lineViewById(op, after.id) };
	}
	const kind = kindInput(input.kind);
	if (lineId) {
		const before = await getLine(op.db, lineId);
		const after = await setLineKind(op.engine, lineId, kind);
		return { kinds, changed: [{ merchant_key: after.merchant_key ?? "", name: after.merchant_name, kind, lines: before && before.kind !== after.kind ? 1 : 0 }], line: await lineViewById(op, after.id) };
	}
	const like = `%${phrase!.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
	const found = (
		await op.db
			.prepare("SELECT merchant_key, MAX(merchant_name) AS name FROM lines WHERE merchant_key IS NOT NULL AND (merchant_key LIKE ? ESCAPE '\\' OR merchant_name LIKE ? ESCAPE '\\' OR merchant_raw LIKE ? ESCAPE '\\') GROUP BY merchant_key ORDER BY COUNT(*) DESC LIMIT ?")
			.bind(like, like, like, MAX_MERCHANTS + 1)
			.all<{ merchant_key: string; name: string | null }>()
	).results;
	if (!found.length) throw new Refused(`no merchant in the ledger matches '${phrase}'`);
	if (found.length > MAX_MERCHANTS) throw new Refused(`'${phrase}' matches more than ${MAX_MERCHANTS} merchants; say it more exactly (for example the name as it appears on the statement)`);
	const changed: SetKindResult["changed"] = [];
	for (const f of found) {
		const r = await setPayeeRule(op.engine, f.merchant_key, { kind }, { cardLines: true }); // the owner named this merchant himself
		changed.push({ merchant_key: f.merchant_key, name: f.name, kind, lines: r.changed });
	}
	return { kinds, changed };
}

// ------------------------------------------------------------------ a line as a subscription

/// 明細 → 「設為訂閱」 {value: true, cadence} / 「不是訂閱」 {value: false}.
export async function lineSubscriptionOp(op: Op, lineId: string, input: Record<string, unknown>): Promise<{ line: LineView; subscription: SubscriptionView | null }> {
	if (typeof input.value !== "boolean") throw new Refused("say value: true (it is a subscription) or false (it is not)");
	const cadence = (optOneOf(input.cadence, SUBSCRIPTION_CADENCES, "cadence") ?? "monthly") as Cadence;
	const id = await markLineSubscription(op.engine, lineId, input.value, cadence, op.today);
	const all = await subscriptionsView(op.db, "all");
	return { line: await lineViewById(op, lineId), subscription: all.subscriptions.find((x) => x.id === id) ?? null };
}

// ------------------------------------------------------------------ 繳款: the owner's word on a bill

/// The 繳款 row a card names: by id, name, last digits or bank ("台新" names
/// its one row, whichever of its cards carries the bill).
function payRowFor(view: PaymentsView, value: string): CardPayment {
	const needle = value.trim().toLowerCase();
	const names = (p: CardPayment) => [p.account, ...p.also_on_this_bill].flatMap((a) => [a.id.toLowerCase(), a.name.toLowerCase()]).concat(p.replaces.map((r) => r.toLowerCase()), [p.account.institution.toLowerCase()]);
	const exact = view.cards.filter((p) => names(p).includes(needle));
	const hits = exact.length ? exact : view.cards.filter((p) => names(p).some((n) => n.includes(needle)));
	if (hits.length === 1) return hits[0]!;
	const list = view.cards.map((p) => p.account.name).join("; ");
	if (!hits.length) throw new Refused(`no credit card matches "${value}". The cards are: ${list}`);
	throw new Refused(`"${value}" matches more than one card: ${hits.map((p) => p.account.name).join("; ")}`);
}

/// 繳款 for the connector: every card's newest bill; or the owner's word on one
/// card — `paid` (「我已繳款」, true; false takes it back) on its newest bill,
/// and/or `autopay` (true auto-debit, false he pays it himself, null = the
/// ledger decides from the statements).
export async function billsOp(op: Op, input: { card?: string; paid?: boolean; autopay?: boolean | null }): Promise<{ bills: PaymentsView; message?: string }> {
	const changing = input.paid !== undefined || input.autopay !== undefined;
	if (changing && !input.card) throw new Refused("say which card (its name, last 4 digits or bank)");
	if (input.card && changing) {
		const row = payRowFor(await paymentsView(op.db, op.today), input.card);
		const said: string[] = [];
		if (input.autopay !== undefined) {
			await setAutopay(op.engine, row.account.id, input.autopay);
			said.push(input.autopay === null ? `${row.account.name}: the ledger decides auto-debit from its statements again` : `${row.account.name} is ${input.autopay ? "" : "not "}paid by auto-debit (the owner's word)`);
		}
		if (input.paid !== undefined) {
			if (!row.last_statement) throw new Refused(`${row.account.name} has no bill yet`);
			await markBillPaid(op.engine, row.last_statement.statement_id, input.paid);
			said.push(input.paid ? `${row.account.name}'s bill closing ${row.last_statement.period_to} is paid (the owner's word; the next statement still checks it)` : `${row.account.name}'s bill closing ${row.last_statement.period_to}: back to what the ledger sees`);
		}
		return { bills: await paymentsView(op.db, op.today), message: said.join(". ") };
	}
	const view = await paymentsView(op.db, op.today);
	return { bills: input.card ? { ...view, cards: [payRowFor(view, input.card)] } : view };
}
