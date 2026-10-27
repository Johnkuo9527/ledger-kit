/// The page's API: every `/api/*` route in CONTRACT.md §5,
/// plus a few the page needs that the contract left open (marked ADDED).
/// app.ts has already checked the page session before any of this runs.
///
///   GET  /api/overview?month=YYYY-MM&group_by=category|merchant   Totals + categories + groups (with share_pct) + Coverage[]
///   GET  /api/lines?from&to&account&category&trip&reimbursable&q&kind&flags&provisional&sort=date|amount&order=desc|asc&cursor&limit
///                                             a page of LineView + next_cursor + the filter's totals
///   GET  /api/months?account=                 MonthView[]
///   GET  /api/trips                           TripView[]
///   GET  /api/subscriptions                   SubscriptionView[] + monthly total
///   GET  /api/needs-ok                        what is waiting on the owner
///   GET  /api/accounts                        ADDED: the account list, for filters
///   GET  /api/wallets                         ADDED (19 Oct 2026): every active prepaid wallet — balance (credit), what
///                                             it is worth (remaining_value), its lots, its uses, the pre-counted story (§15.3)
///   GET  /api/reimbursable-ranges             ADDED: the ranges, to show and remove
///   GET  /api/status                          ADDED: open alarms, the last run, the engine's phase,
///                                             and `gmail` — which mailbox 「連接 Gmail」 connected (google.ts)
///   POST /api/trips/:id/confirm | /reject     the updated TripView (+ its lines)
///   POST /api/trips/:id/restore | /edit       ADDED
///   POST /api/trips {name,start_date,end_date,destination?}  ADDED: the owner starts his own trip (confirmed)
///   POST /api/lines/:id/reimbursable {value}  the updated LineView
///   GET  /api/categories                      ADDED: the owner's category list (LEDGER_CATEGORIES + his own)
///   GET  /api/categories?usage=1              + was (a renamed category → its starting name) + usage {lines, rules} per category
///   POST /api/categories {add?|rename+to?|delete+move_to?}  the owner adds, renames (everything named it follows) or
///                                             deletes a category (what uses it moves to move_to first) — src/categories.ts
///   POST /api/lines/:id/offset {to: salary|card|line|none, account_id?, target_line_id?}  ADDED: what an income offsets
///   POST /api/lines/:id/category {category, scope?: auto|merchant|line | apply_to_merchant?}  ADDED: the owner's pick,
///                                             learned for the payee (auto: not for a person) — PickResult (+ changed)
///   POST /api/lines/:id/kind {kind, apply_to_merchant}  ADDED (r2): what the money is — spending (purchase) |
///                                             investment | loan_repayment | friend_transfer | transfer | card_payment |
///                                             wallet_topup + wallet (this line only: money into one of his wallets,
///                                             "grabpay" | "sample-bistro" | "demo-noodle"; grabpay_topup = wallet_topup to GrabPay;
///                                             credit "240" = the credit it gave — 19 Oct 2026; none = the shop's deal, else no bonus);
///                                             merchant = the owner's payee rule — {line, scope, merchant_name, changed}
///   POST /api/lines/:id/subscription {value, cadence?}  ADDED (r2): mark a line's merchant a subscription
///                                             (true, weekly|monthly|quarterly|yearly) or not one (false) — {line, subscription}
///   POST /api/lines/:id/home {home_amount}      ADDED: correct a cash / 台新 line's SGD
///   POST /api/reimbursable-ranges {from,to,note}       the range + how many lines it covers (count)
///                                             + how many changed (affected_lines)
///   POST /api/reimbursable-ranges/:id/delete  ADDED
///   POST /api/cash {date,amount,currency,merchant,note,category?,home_amount?,account_id?}  the new LineView
///                                             (account_id "grabpay" / "sample-bistro": paid from that wallet —
///                                             14 Oct / 19 Oct 2026; a wallet's default category when none is named)
///   POST /api/subscriptions/:id {action}      ADDED: ignore / cancelled / active (still running) / restore
///   POST /api/wallet-names {name, account_id} ADDED: name a held tap's card; held taps re-tried
///   GET  /api/payments                        ADDED (r2, D): per credit card its newest bill, paid since,
///                                             outstanding, due date, status, unbilled + a total row (src/payments.ts)
///   POST /api/accounts/:id/settings {statement_day, due_day, autopay}  ADDED (r2, C): the owner's cut-off / due day
///                                             (1–31; both null = back to his statements) — {account};
///                                             autopay true|false|null (14 Oct): paid by auto-debit, the owner's word
///                                             beats the statements; null = the ledger decides again. Each key only if sent.
///   POST /api/payments/:statement_id/paid {paid: true|false}  ADDED (14 Oct): the owner's 「我已繳款」 on a bill
///                                             the ledger cannot see paid (false takes it back) — {card: CardPayment}
///   POST /api/payments/:statement_id/seen     ADDED: 待確認 → 繳款「知道了」 on a bill the next statement shows unpaid
///   POST /api/lines/:id/review {action: accept|void|link|retry_rate|pair, category?, refund_of?, line_id?}  ADDED (r2, A; pair fix)
///   POST /api/needs-ok/held/:id/dismiss {reason?}  ADDED (r2, A): a held tap / alert / statement line is not a charge
///   POST /api/months/:id/reviewed | /recheck  ADDED (r2, A): the owner looked at a statement / check it again now
///   POST /api/needs-ok/pdf/:bank/retry        ADDED (r2, A): statements waiting for a PDF password, tried now
///   POST /api/statements/upload (multipart: files[], account_id?)  ADDED (Citi): the owner's own statement
///                                             PDFs, queued for the cron's reading — {files[{filename, status, id,
///                                             message}], queued, message} (src/uploads.ts)
///   GET  /api/statements/uploads              ADDED: the uploads' progress list (src/upload-status.ts)
///   POST /api/statements/uploads/:id/account {account_id} | /dismiss  ADDED: 待確認 → uploads
///   POST /api/wallet-topups/:line_id/credit {credit: "240" | null}  ADDED (19 Oct 2026): 待確認 「這次儲值有送嗎？」 —
///                                             the credit a prepaid top-up gave (null = no bonus); either side's line id
///   POST /api/wallet-sms/:id/accept | /checked | /dismiss  ADDED (19 Oct 2026): 待確認 on a shop's SMS — take its
///                                             balance (one adjustment line), I'll check, or (unreadable) I'll record it
///
/// Every 待確認 item carries its `actions` (src/queries.ts needsOk); each POST
/// answers `message`, the page's toast.
///
/// Every answer is the §5.1 envelope. A read says `ok: true` explicitly — the
/// page treats anything else as "couldn't load", never as an empty list.

import { addWalletName, dismissEvidence, markStatementReviewed, recheckAnyStatement, REVIEW_ACTIONS, reviewLine, setCardDays, type ReviewAction } from "../../src/engine";
import { markBillPaid, markUnpaidSeen, paymentsView, setAutopay } from "../../src/payments";
import { accountViews, decodeCursor, linePage, lineViews, LINE_FLAGS, loadRanges, loadTrip, monthViews, needsOk, OVERVIEW_GROUP_BYS, overview, startViewContext, subscriptionsView, totalsFor, tripViews, tripWithMembers, walletDetails, type LineFilter, type LineSort, type OverviewGroupBy } from "../../src/queries";
import { Refused } from "../../src/refused";
import { LINE_KINDS, type LineKind } from "../../src/types";
import type { LineFlag } from "../../src/views";
import { engineStatus } from "./alarms";
import { uploadAccount, uploadDismiss, uploadFromPage, uploadsList } from "./uploads";
import { gmailLinkStatus } from "./google";
import { HttpError, ok, readJsonObject } from "./http";
import { categoryUsage } from "./categories";
import { addRangeOp, cashOp, editCategoriesOp, incomeOffsetOp, lineKindOp, lineSubscriptionOp, lineViewById, pickCategoryOp, removeRangeOp, resolveAccount, setLineReimbursableOp, smsAnswerOp, subscriptionsOp, topUpCreditOp, tripOp, type Op } from "./ops";
import { oneOf, optBool, optInt, optIsoDate, optOneOf, optText, text } from "./validate";
import { say } from "../../src/words";

export const LINES_DEFAULT_LIMIT = 50;
export const LINES_MAX_LIMIT = 200;

type Handler = (op: Op, request: Request, url: URL, params: string[]) => Promise<Response>;

interface Route {
	method: "GET" | "POST";
	pattern: RegExp;
	handler: Handler;
}

const seg = "([^/]+)";

const routes: Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/overview$/,
		handler: async (op, _r, url) => {
			const month = url.searchParams.get("month") || op.today.slice(0, 7);
			if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Refused("month must be written like 2026-03");
			const groupBy = (optOneOf(url.searchParams.get("group_by"), OVERVIEW_GROUP_BYS, "group_by") ?? "category") as OverviewGroupBy;
			return ok(await overview(op.db, month, op.today, groupBy));
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/lines$/,
		handler: async (op, _r, url) => {
			const q = (k: string) => url.searchParams.get(k);
			const from = optIsoDate(q("from"), "from");
			const to = optIsoDate(q("to"), "to");
			if (from && to && from > to) throw new Refused("the period ends before it starts");
			const accountValue = optText(q("account"), "account", 120);
			// Everything a line's view needs goes to D1 now, alongside whatever the filter
			// needs first (20 Oct 2026: one round trip after another made 明細 the slow tab).
			const ctx = startViewContext(op.db);
			let lineIds: string[] | null = null;
			const tripId = optText(q("trip"), "trip", 120);
			if (tripId) {
				const found = await tripWithMembers(op.db, tripId);
				if (!found) throw new HttpError(404, "no such trip");
				lineIds = found.members.map((l) => l.id);
			}
			const flags = (q("flags") ?? "")
				.split(",")
				.map((f) => f.trim())
				.filter(Boolean)
				.map((f) => oneOf(f, LINE_FLAGS, "flags") as LineFlag);
			const filter: LineFilter = {
				from,
				to,
				account_id: accountValue ? (await resolveAccount(op.db, accountValue, ctx.accounts)).id : null,
				kind: optOneOf(q("kind"), LINE_KINDS, "kind") as LineKind | null,
				category: optText(q("category"), "category", 80),
				merchant: optText(q("q"), "q", 200),
				line_ids: lineIds,
				reimbursable: optBool(q("reimbursable"), "reimbursable"),
				flags: flags.length ? flags : null,
				provisional: optBool(q("provisional"), "provisional"),
			};
			const rawCursor = q("cursor");
			const cursor = rawCursor ? decodeCursor(rawCursor) : null;
			if (rawCursor && !cursor) throw new Refused("that page cursor is not one this ledger made; start from the first page");
			const limit = optInt(q("limit"), "limit", 1, LINES_MAX_LIMIT) ?? LINES_DEFAULT_LIMIT;
			const sort: LineSort = {
				by: (optOneOf(q("sort"), ["date", "amount"], "sort") ?? "date") as LineSort["by"],
				order: (optOneOf(q("order"), ["desc", "asc"], "order") ?? "desc") as LineSort["order"],
			};
			const [page, totals] = await Promise.all([linePage(op.db, filter, limit, cursor, sort), totalsFor(op.db, filter)]);
			// totals: the WHOLE filter, not this page (the page shows the filtered sum).
			return ok({ lines: await lineViews(op.db, page.lines, ctx), next_cursor: page.next_cursor, totals });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/months$/,
		handler: async (op, _r, url) => {
			const account = optText(url.searchParams.get("account"), "account", 120);
			const id = account ? (await resolveAccount(op.db, account)).id : null;
			return ok({ months: await monthViews(op.db, id) });
		},
	},
	{ method: "GET", pattern: /^\/api\/trips$/, handler: async (op) => ok({ trips: await tripViews(op.db) }) },
	{ method: "GET", pattern: /^\/api\/subscriptions$/, handler: async (op) => ok(await subscriptionsView(op.db, "all")) },
	{ method: "GET", pattern: /^\/api\/needs-ok$/, handler: async (op) => ok(await needsOk(op.db, { categories: op.categories, today: op.today })) },
	{ method: "GET", pattern: /^\/api\/payments$/, handler: async (op) => ok(await paymentsView(op.db, op.today)) },
	{
		method: "POST",
		pattern: new RegExp(`^/api/accounts/${seg}/settings$`),
		handler: async (op, request, _u, [id]) => {
			const body = await readJsonObject(request);
			const day = (k: "statement_day" | "due_day") => (k in body ? optInt(body[k], k, 1, 31) : undefined);
			const account = await resolveAccount(op.db, id!);
			const days = "statement_day" in body || "due_day" in body;
			const autopay = "autopay" in body ? optBool(body.autopay, "autopay") : undefined;
			if (!days && autopay === undefined) throw new Refused("say statement_day / due_day, or autopay");
			if (autopay !== undefined) await setAutopay(op.engine, account.id, autopay);
			if (days) await setCardDays(op.engine, account.id, { statement_day: day("statement_day"), due_day: day("due_day") });
			const view = (await accountViews(op.db)).find((a) => a.id === account.id)!;
			const said = say(days ? (view.settings_source === "owner" ? "api.days_owner" : "api.days_statement") : autopay === null ? "api.autopay_ledger" : autopay ? "api.autopay_on" : "api.autopay_off");
			return ok({ account: view, message: said });
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/payments/${seg}/paid$`),
		handler: async (op, request, _u, [id]) => {
			const body = await readJsonObject(request);
			if (typeof body.paid !== "boolean") throw new Refused("say paid: true (you paid this bill) or false (take it back)");
			const bill = await markBillPaid(op.engine, id!, body.paid);
			const card = (await paymentsView(op.db, op.today)).cards.find((c) => c.last_statement && (c.last_statement.statement_id === bill.id || c.previous_bill?.statement_id === bill.id)) ?? null;
			return ok({ card, message: say(body.paid ? "api.paid" : "api.paid_undo") });
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/payments/${seg}/seen$`),
		handler: async (op, _r, _u, [id]) => {
			await markUnpaidSeen(op.engine, id!);
			return ok({ statement_id: id, message: say("api.unpaid_seen") });
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/lines/${seg}/review$`),
		handler: async (op, request, _u, [id]) => {
			const body = await readJsonObject(request);
			const action = oneOf(body.action, REVIEW_ACTIONS, "action") as ReviewAction;
			const category = optText(body.category, "category", 80);
			if (category && op.categories.length && !op.categories.includes(category)) throw new Refused(`${category} is not one of your categories`);
			const line = await reviewLine(op.engine, id!, action, {
				category,
				refund_of: optText(body.refund_of ?? body.line_id, "refund_of", 120),
				line_id: optText(body.line_id, "line_id", 120),
			});
			const said = say(`api.review_${action}`);
			// A removed line is no longer in the line list, so its view is built from the row itself.
			return ok({ line: (await lineViews(op.db, [line]))[0], message: said });
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/needs-ok/held/${seg}/dismiss$`),
		handler: async (op, request, _u, [id]) => {
			const body = await readJsonObject(request);
			await dismissEvidence(op.engine, id!, optText(body.reason, "reason", 80));
			return ok({ evidence_id: id, message: say("api.held_dismissed") });
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/months/${seg}/(reviewed|recheck)$`),
		handler: async (op, _r, _u, [id, verb]) => {
			if (verb === "reviewed") {
				await markStatementReviewed(op.engine, id!);
				return ok({ statement_id: id, message: say("api.month_reviewed") });
			}
			const r = await recheckAnyStatement(op.engine, id!);
			const fine = r.recon.ok && r.bill_check !== "mismatch";
			return ok({ statement_id: id, reconciled: r.recon.ok, bill_check: r.bill_check, message: say(fine ? "api.month_fine" : "api.month_still_off") });
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/needs-ok/pdf/${seg}/retry$`),
		handler: async (op, _r, _u, [bank]) => {
			const r = await op.db
				.prepare("UPDATE work SET not_before = NULL, updated_at = ? WHERE stage = 'waiting' AND error = 'pdf password'")
				.bind(new Date().toISOString())
				.run();
			const n = r.meta.changes ?? 0;
			return ok({ bank, retried: n, message: n ? say("api.pdf_retry", { n }) : say("api.pdf_none") });
		},
	},
	{ method: "GET", pattern: /^\/api\/accounts$/, handler: async (op) => ok({ accounts: await accountViews(op.db) }) },
	{ method: "GET", pattern: /^\/api\/wallets$/, handler: async (op) => ok({ wallets: await walletDetails(op.db) }) },
	{ method: "GET", pattern: /^\/api\/reimbursable-ranges$/, handler: async (op) => ok({ ranges: await loadRanges(op.db) }) },
	{
		method: "GET",
		pattern: /^\/api\/status$/,
		handler: async (op) => {
			const [status, gmail] = await Promise.all([engineStatus(op.db, { env: op.env, today: op.today }), op.env ? gmailLinkStatus(op.env, op.db) : null]);
			return ok({ ...status, gmail });
		},
	},
	{ method: "GET", pattern: /^\/api\/categories$/, handler: async (op, _r, url) => ok({ categories: op.categories, was: op.categoryWas, ...(url.searchParams.get("usage") === "1" ? { usage: await categoryUsage(op) } : {}) }) },
	{ method: "POST", pattern: /^\/api\/categories$/, handler: async (op, request) => ok(await editCategoriesOp(op, await readJsonObject(request))) },
	{
		method: "POST",
		pattern: new RegExp(`^/api/lines/${seg}/offset$`),
		handler: async (op, request, _u, [id]) => ok(await incomeOffsetOp(op, id!, await readJsonObject(request))),
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/lines/${seg}/kind$`),
		handler: async (op, request, _u, [id]) => ok(await lineKindOp(op, id!, await readJsonObject(request))),
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/lines/${seg}/subscription$`),
		handler: async (op, request, _u, [id]) => ok(await lineSubscriptionOp(op, id!, await readJsonObject(request))),
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/lines/${seg}/category$`),
		handler: async (op, request, _u, [id]) => ok(await pickCategoryOp(op, id!, await readJsonObject(request))),
	},
	{
		method: "POST",
		pattern: /^\/api\/trips$/,
		handler: async (op, request) => ok(await tripOp(op, { ...(await readJsonObject(request)), action: "create" })),
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/trips/${seg}/(confirm|reject|restore|edit)$`),
		handler: async (op, request, _u, [id, verb]) => {
			const body = await readJsonObject(request);
			if (!(await loadTrip(op.db, id!))) throw new HttpError(404, "no such trip");
			const action = verb === "reject" ? "dismiss" : verb!;
			const r = await tripOp(op, { ...body, action, trip_id: id });
			return ok(r);
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/lines/${seg}/reimbursable$`),
		handler: async (op, request, _u, [id]) => {
			const body = await readJsonObject(request);
			if (!("value" in body)) throw new Refused("say value: true, false, or null (null clears your choice)");
			await setLineReimbursableOp(op, id!, body.value);
			return ok({ line: await lineViewById(op, id!) });
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/lines/${seg}/home$`),
		handler: async (op, request, _u, [id]) => {
			const body = await readJsonObject(request);
			return ok(await cashOp(op, { line_id: id, home_amount: body.home_amount }));
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/reimbursable-ranges$/,
		handler: async (op, request) => {
			const r = await addRangeOp(op, await readJsonObject(request));
			return ok({ range: r.range, count: r.count, affected_lines: r.result.affected_lines });
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/reimbursable-ranges/${seg}/delete$`),
		handler: async (op, _r, _u, [id]) => {
			const r = await removeRangeOp(op, id!);
			return ok({ ranges: r.ranges, affected_lines: r.affected_lines });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/cash$/,
		handler: async (op, request) => {
			const body = await readJsonObject(request);
			// This route only ADDS; correcting a line is /api/lines/:id/home.
			const { line_id: _ignored, ...add } = body;
			return ok(await cashOp(op, add), 201);
		},
	},
	{
		method: "POST",
		pattern: new RegExp(`^/api/subscriptions/${seg}$`),
		handler: async (op, request, _u, [id]) => {
			const body = await readJsonObject(request);
			const exists = await op.db.prepare("SELECT 1 AS x FROM subscriptions WHERE id = ?").bind(id!).first();
			if (!exists) throw new HttpError(404, "no such subscription");
			return ok(await subscriptionsOp(op, { subscription_id: id, action: body.action ?? null, status: "all" }));
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/wallet-names$/,
		handler: async (op, request) => {
			const body = await readJsonObject(request);
			const account = await resolveAccount(op.db, text(body.account_id, "account_id", 120));
			const r = await addWalletName(op.engine, text(body.name, "name", 120), account.id);
			const recorded = r.retried.filter((x) => x.status === "created" || x.status === "attached").length;
			// still_held > 0: more of this card's taps than one request retries; naming it again retries the next few.
			return ok({ wallet_key: r.wallet_key, account_id: account.id, recorded, still_held: r.still_held });
		},
	},
	// (19 Oct 2026): prepaid cards — a top-up's bonus credit, a shop's SMS (src/wallet-sms.ts).
	{ method: "POST", pattern: new RegExp(`^/api/wallet-topups/${seg}/credit$`), handler: async (op, request, _u, [id]) => ok(await topUpCreditOp(op, id!, await readJsonObject(request))) },
	{ method: "POST", pattern: new RegExp(`^/api/wallet-sms/${seg}/(accept|checked|dismiss)$`), handler: async (op, _r, _u, [id, answer]) => ok(await smsAnswerOp(op, id!, answer as "accept" | "checked" | "dismiss")) },
	// : statement PDFs the owner uploads himself (Citi emails none) — src/uploads.ts.
	{ method: "POST", pattern: /^\/api\/statements\/upload$/, handler: async (op, r) => uploadFromPage(op, r, new Date(op.engine.now())) },
	{ method: "GET", pattern: /^\/api\/statements\/uploads$/, handler: async (op) => uploadsList(op, new Date(op.engine.now())) },
	{ method: "POST", pattern: /^\/api\/statements\/uploads\/([^/]+)\/account$/, handler: async (op, r, _u, [id]) => uploadAccount(op, r, id!, new Date(op.engine.now())) },
	{ method: "POST", pattern: /^\/api\/statements\/uploads\/([^/]+)\/dismiss$/, handler: async (op, _r, _u, [id]) => uploadDismiss(op, id!, new Date(op.engine.now())) },
];

/// null = no such route (app.ts answers 404 — only ever after the session check).
export async function api(op: Op, request: Request, url: URL): Promise<Response | null> {
	const method = request.method === "HEAD" ? "GET" : request.method;
	let pathMatched = false;
	for (const r of routes) {
		const m = r.pattern.exec(url.pathname);
		if (!m) continue;
		pathMatched = true;
		if (r.method !== method) continue;
		const params = m.slice(1).map((p) => {
			try {
				return decodeURIComponent(p);
			} catch {
				throw new Refused("that address is not valid");
			}
		});
		return r.handler(op, request, url, params);
	}
	if (pathMatched) throw new HttpError(405, "that action is not allowed on this address");
	return null;
}

/// For the tests: every route the page can call, so the session sweep and the
/// envelope sweep can never miss a new one.
export const API_ROUTES: readonly { method: string; pattern: RegExp }[] = routes.map((r) => ({ method: r.method, pattern: r.pattern }));
