/// The claude.ai connector: the five tools of CONTRACT.md §6, over MCP's
/// Streamable HTTP transport at /mcp. The OAuth library in index.ts has already
/// checked the bearer token and put the signed-in person's props on ctx.
///
/// Stateless, like the owner's other connectors: a fresh server per request, JSON
/// answers (no event stream), nothing kept between calls.
///
/// Every tool answers with the §5.1 envelope as JSON text: `{ "ok": true, … }`
/// or `{ "ok": false, "message" }` (and then the MCP result is marked as an
/// error, so Claude knows nothing was done). Writes go through engine.ts as
/// The owner (actor 'owner'): what he tells Claude is his own word (CONTRACT.md §6).

import { say } from "../../src/words";
import { home, type Home } from "../../src/home";
import { formatMoney } from "../../src/money";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { LINE_FLAGS } from "../../src/queries";
import { isRefused } from "../../src/refused";
import { LINE_KINDS } from "../../src/types";
import { normalizeEmail } from "./codes";
import { NOT_SET_UP, useHome, type Ctx, type Deps, type LedgerEnv } from "./env";
import { fail } from "./http";
import { fixedCategories } from "./categorise";
import { CATEGORY_ACTIONS, categoriesToolOp } from "./categories";
import { billsOp, cashOp, editCategoriesOp, GROUP_BYS, incomeOffsetOp, makeOp, markReimbursableOp, OFFSET_TARGETS, queryOp, setCategoryOp, setKindOp, subscriptionsOp, SUBSCRIPTION_ACTIONS, TRIP_ACTIONS, tripOp, type Op } from "./ops";

/// What claude.ai is told about the ledger, in the owner's own home currency and time zone.
export const serverInstructions = (h: Home = home()): string => `This is the owner's personal ledger: every card, bank account, prepaid wallet (GrabPay, a shop's prepaid card) and cash purchase, one line per real purchase, in his home currency (${h.currency}).

How to read it:
- Amounts are strings with their currency ("${formatMoney(123450, h.currency)}"). Spending totals are in ${h.currency}; fields named *_home are in ${h.currency}. Card bills and transfers between his own accounts are never spending.
- A figure marked "estimate" (or "reference") is not final: foreign charges are estimated until the card's statement arrives; a card billed in another currency (a Taiwanese card in TWD, say) and foreign cash are converted at a reference rate. Always say when part of a total is an estimate (split.estimate_home).
- "provisional" on a line means no statement has confirmed it yet.
- Every answer carries "coverage". "partial" on a card that sends no alert emails is normal between statements: its spending is complete only up to complete_through, and what came after arrives with the next statement (next_statement_due). Say so in a few words. Never present a missing period as zero spending. Only "overdue": true means something is wrong (the statement is late) — then repeat its message to the owner, with its reason.
- Wallets: prepaid money the owner holds somewhere — GrabPay and prepaid shop cards, each an account of kind "wallet" (ledger_query's account list names them and their ids). Each has a balance (coverage.wallet.balance) and a start date (coverage.wallet.since): nothing before that date is in it.
- A prepaid card's balance is in the SHOP'S CREDIT, so it matches the shop's own site or receipt. A shop may give bonus credit ("pay 200, get 240"): each top-up's credit then cost less than face value, and each purchase from the card is recorded at its REAL cost — credit used × money paid ÷ credit got, oldest top-up first (a 24-credit meal from a 200-for-240 top-up costs 20.00 of his money). On such a line amount.original/billed are the credit used and amount.home the real cost; line.credit says so in words. Spending totals use the real cost. A top-up from his bank or card is a transfer to his own wallet, never spending; spending FROM a wallet is spending, once, in its real category.
- A wallet's opening balance may have been counted as spending already, when it was topped up before the ledger began. A purchase paid with that balance shows in its real category, with an automatic "wallet_offset" line (negative, in the old top-ups' category) so it is not counted twice — the line's "wallet" field says so; mention it when a total includes one. Grab's own emails keep GrabPay up to date.
- A wallet with no statements and no emails ("told_only") counts only the purchases the owner tells you — say so when you give its balance (its coverage message says it). A card line at the shop for a whole number of dollars is taken as a top-up of it; any other amount is a purchase paid by card. A purchase that takes such a balance below zero is still recorded but flagged needs_review — he may not have told you a top-up.
- A shop that texts after every use (its SMS words and sender are set on the wallet) has each SMS sent to the ledger by the owner's iPhone; it records the purchase and checks the balance the SMS states (a difference goes to his ${say("ui.tab_review")} list on the page).
- Flags: "missed_by_alerts" (only the statement had it), "not_on_statement" (an alert or tap the statement never confirmed — often a reversed hold), "unlinked_refund", "no_rate", "needs_review".

How to change it (each change is the owner's word and counts at once):
- ledger_add_cash: cash he spent, or (account = a wallet's id, e.g. "grabpay") something he paid from one of his wallets; for a prepaid card, amount is what the shop deducted from the card (its credit), and the ledger works out the real cost; or (account = the card, e.g. "citi" or a card's id) a purchase on one of his credit or debit cards that no alert or Apple Pay tap brought (below the bank's alert threshold, the Shortcut failing) — NEVER record a card purchase as cash: the card's statement would count it twice. A card purchase is provisional, shows as added by the owner (evidence "manual"), and the card's statement — or a late alert or tap — joins that line; if an alert or tap already has it, his word joins it (already_recorded true); or correct the ${h.currency} figure of a cash or reference-rate line.
- ledger_mark_reimbursable: dates his company pays for, one line either way, or a whole trip.
- ledger_confirm_trip: trips the ledger proposed from flight and hotel emails, or one the owner starts himself (create); add or remove any line from a trip (edit).
- ledger_subscriptions: say a detected subscription is not one, that he cancelled it, or that it is still running.
- ledger_set_kind: say what money paid to a payee (or one line) IS when it is not spending — an investment, a loan repayment, money a friend handled for him (paying on his behalf, or his money swapped for another currency), a transfer between his own accounts, a card bill, a top-up of one of his wallets (kind wallet_topup with wallet, one line; credit = the credit he got when the shop gave a bonus) — or that it is spending after all. Never in spending totals; overview non_spending totals them.
- ledger_income_offset: say what money the owner received offsets — salary, one of his credit cards, or one purchase (a friend paying back a dinner) — so his totals are true.
- ledger_bills: ${say("ui.tab_bills")} — each credit card's newest bill: what is still to pay, by when, and its status. "autopay_pending" means the card is paid by auto-debit from an account the ledger does not track: past its due date it is NOT overdue — the next statement confirms the payment. "overdue" comes only with evidence (status_reason): no payment seen after the due date on a card he pays himself, or the next statement shows the bill before was not paid in full (previous_bill.verdict "unpaid"). When the owner says he paid a bill the ledger cannot see, give card and paid true (his word; the next statement still checks it); autopay true/false says how a card is paid.
- ledger_categories: rename or delete one of his categories (list shows what uses each). A delete of a category in use is refused with the count: tell the owner the count, ask which category those lines move to, then call again with move_to.
- ledger_set_category: add_category adds to his list (remove_category = ledger_categories delete); put a merchant (all its lines, now and later) or one line in one of the owner's categories; with neither, list his categories. To see spending by category use ledger_query with group_by "category".

Dates are YYYY-MM-DD on his own calendar (${h.timeZone}). If a call is refused, the message says why in plain words; tell the owner, do not guess around it.`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/// One tool call: open the ledger as the owner, run, wrap in the envelope. A Refused
/// is the person's mistake and its message is shown; anything else is logged
/// and reported without internals.
export async function runTool(env: LedgerEnv, deps: Deps, fn: (op: Op) => Promise<object>): Promise<ToolResult> {
	try {
		const op = await makeOp(env, deps, "owner");
		const payload = await fn(op);
		return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }) }] };
	} catch (e) {
		const message = isRefused(e) ? e.message : "the ledger could not answer just now; nothing was changed by this call";
		if (!isRefused(e)) console.error("ledger tool failed", e);
		return { content: [{ type: "text", text: JSON.stringify({ ok: false, message }) }], isError: true };
	}
}

const date = (what: string) => z.string().describe(`${what}, YYYY-MM-DD (the owner's own day, ${home().timeZone})`);
const amountText = (what: string) => z.union([z.string(), z.number()]).describe(`${what}, as written, e.g. "12.50"`);

/// How much one call may carry (GHSA-46jr-4wx8-v453: without a cap, one request inside the SDK's
/// 4 MiB default could run the worker out of memory while its arguments were checked). The largest
/// honest call is a trip edit: at most 500 line ids each way (validate.ts idList), ~1,000 elements;
/// everything else is a handful of fields.
/// test/mcp-limits.test.ts pins both.
export const LEDGER_MCP_LIMITS = {
	/// Array elements + object members in one call's arguments.
	maxToolInputElements: 10_000,
	/// Bytes in one request's body.
	maxRequestBodySize: 1_048_576,
} as const;

export function buildServer(env: LedgerEnv, deps: Deps): McpServer {
	const server = new McpServer(
		{ name: "ledger", version: "1.0.0" },
		{ instructions: serverInstructions(), maxToolInputElements: LEDGER_MCP_LIMITS.maxToolInputElements },
	);

	server.registerTool(
		"ledger_query",
		{
			title: "Ask the ledger",
			description:
				"Find spending and lines: by period, account, category, merchant, trip, reimbursable or flags. Returns the total for EVERYTHING that matched (split into confirmed and estimate), the top lines (largest first unless sort is 'date'), optional groups, and each account's coverage. Default period: this calendar month so far.",
			inputSchema: {
				from: date("First day").optional(),
				to: date("Last day (default today)").optional(),
				account_id: z.string().optional().describe("An account's id, or part of its name (e.g. 'HSBC', 'Visa', '5507')"),
				kind: z.enum(LINE_KINDS).optional(),
				category: z.string().optional().describe("Exact category; 'Uncategorised' for lines with none"),
				merchant: z.string().optional().describe("Text in the merchant name, e.g. 'grab' (long text is cut to about 40 letters / 14 Chinese characters)"),
				trip_id: z.string().optional().describe("A trip's id, or part of its name or destination"),
				reimbursable: z.boolean().optional(),
				flags: z.array(z.enum(LINE_FLAGS as [string, ...string[]])).optional().describe("Lines with ANY of these flags"),
				provisional: z.boolean().optional().describe("true = not yet confirmed by a statement"),
				group_by: z.enum(GROUP_BYS).optional(),
				sort: z.enum(["amount", "date"]).optional(),
				limit: z.number().int().min(1).max(200).optional().describe("How many lines to return (default 50); totals always cover every match"),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => queryOp(op, args)),
	);

	server.registerTool(
		"ledger_add_cash",
		{
			title: "Add cash, wallet or card spending",
			description:
				"Record cash the owner spent (date defaults to today, currency to his home currency). Foreign cash without home_amount is converted at the reference rate and marked as an estimate. With account 'grabpay' (or his GrabPay wallet's id): something he paid from his GrabPay wallet (in its own currency, from the wallet's start date) — give the category (e.g. Drinks, Food, Grab/Uber); if Grab's own email already recorded that purchase (same amount, same or next day) his word joins that line (already_recorded true) instead of adding a second one; the answer's line.wallet says when it was paid with balance already counted at top-up. With a prepaid card — account = that wallet's id (from its start date; if its shop's SMS already recorded the meal, his word joins that line, already_recorded true): a meal paid from that card (category Food unless he names another). IMPORTANT: amount is what the shop deducted from the card — its credit, as on the shop's receipt or SMS — NOT what it cost him; the ledger records the real cost itself (credit × what he paid ÷ the credit he got at top-up, e.g. 24 credit from a 200-for-240 top-up = 20.00 of his money) and the card's balance goes down by the credit. If the balance would go below zero the purchase is still recorded but flagged needs_review (ask him whether he topped up). With a credit or debit card — account = the card's id or a piece of its name (e.g. 'citi', 'visa'): a purchase on that card that no bank alert or Apple Pay tap recorded (small amounts under the bank's alert threshold, or a day the Shortcut failed). Give date, amount (as charged, in the merchant's currency; default the card's own currency), merchant and optionally category and note — never home_amount (the statement confirms it; a foreign amount is estimated meanwhile). It is a line on that card exactly like a tap: provisional, shown as added by the owner, and when the card's statement (or a late alert or tap) brings the same purchase — same card, same amount, within a few days — it joins this line, never a second one. If an alert or tap for that card and amount (same or next day) is already in the ledger, his word joins that line instead (already_recorded true; his category is kept). If several different purchases fit, nothing is added and the answer lists them. Never record a card purchase as cash: the statement would then count it twice. A bank account is refused (its lines come from its alerts and statements). To correct the home-currency figure of an existing cash or reference-rate line instead, give only line_id and home_amount (a card's foreign estimate cannot be corrected: its statement will).",
			inputSchema: {
				account: z.string().optional().describe("Where the money came from: 'cash' (default), 'grabpay' (his GrabPay wallet) or any of his wallets by id — or one of his credit/debit cards by id or a piece of its name (e.g. 'citi') for a purchase no alert or tap recorded"),
				account_id: z.string().optional().describe("The same as account (either name works)"),
				date: date("When it was spent").optional(),
				amount: amountText("How much, in the cash's currency. For a prepaid card: what the shop deducted from the card (its credit), not the real cost").optional(),
				currency: z.string().optional().describe(`Three letters, e.g. ${home().currency}, USD, JPY (default ${home().currency}; for a wallet or card, its own currency)`),
				merchant: z.string().optional().describe("Where, e.g. 'Hawker centre'"),
				category: z.string().optional(),
				note: z.string().optional(),
				home_amount: amountText(`What it cost in ${home().currency}, if the owner knows (e.g. from his money-changer rate)`).optional(),
				line_id: z.string().optional().describe("Only to correct an existing line's home-currency figure"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => cashOp(op, args)),
	);

	server.registerTool(
		"ledger_mark_reimbursable",
		{
			title: "Mark spending as reimbursable",
			description:
				"Give exactly one of: range {from, to, note} — every spending line in those dates is reimbursable by the owner's company; remove_range_id; line_id with reimbursable true/false (null clears the owner's own choice, so the ranges decide again); or trip_id — the trip's dates become a range and its bookings are marked too.",
			inputSchema: {
				range: z.object({ from: date("First day"), to: date("Last day"), note: z.string().optional() }).optional(),
				remove_range_id: z.string().optional(),
				line_id: z.string().optional(),
				reimbursable: z.boolean().nullable().optional(),
				trip_id: z.string().optional().describe("A trip's id, or part of its name or destination"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => markReimbursableOp(op, args)),
	);

	server.registerTool(
		"ledger_set_category",
		{
			title: "Set a category",
			description: `Call with nothing to list the owner's categories (his starting list: ${fixedCategories(env).join(", ") || "(none set)"}; plus any he added). Give category and EITHER merchant — part of a merchant's name; every line of the matching merchants (at most 15), now and in future, goes in that category and no automatic rule changes it — OR line_id for one line only. With neither, it lists the categories.`,
			inputSchema: {
				category: z.string().optional().describe("One of the owner's categories, as listed"),
				add_category: z.string().optional().describe("A new category of the owner's own, added to his list"),
				remove_category: z.string().optional().describe("A category taken off his list — only when nothing uses it; to move what uses it, use ledger_categories delete with move_to"),
				merchant: z.string().optional().describe("Part of the merchant's name, e.g. 'Grab' or 'FairPrice'"),
				line_id: z.string().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => runTool(env, deps, async (op) => (args.add_category || args.remove_category ? editCategoriesOp(op, { add: args.add_category, remove: args.remove_category }) : setCategoryOp(op, args))),
	);

	server.registerTool(
		"ledger_categories",
		{
			title: "Rename or delete a category",
			description:
				"The owner's category list. action 'list' (default): every category with how many lines and rules use it. 'rename': category → new_name; every line, payee rule, learned merchant rule and wallet default follows at once (a name he already has is refused — to merge two, delete one and move it to the other). 'delete': category; when lines or rules use it, it is refused with the count until move_to names the category they move to — tell the owner the count and ask him which one, never choose for him; everything moves and the category is gone in one step. Each change is the owner's word and counts at once; spending totals per category move with it, the overall total does not change.",
			inputSchema: {
				action: z.enum(CATEGORY_ACTIONS).optional(),
				category: z.string().optional().describe("The category to rename or delete, as listed"),
				new_name: z.string().optional().describe("With rename: the new name (no comma, at most 40 characters)"),
				move_to: z.string().optional().describe("With delete: the category its lines and rules move to"),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => categoriesToolOp(op, args)),
	);

	server.registerTool(
		"ledger_set_kind",
		{
			title: "Say what money is",
			description:
				"What money paid to a payee IS, when the owner says so: kind 'investment' (e.g. to his broker), 'loan_repayment', 'friend_transfer' (a friend paying on his behalf, or swapping his money for another currency), 'own_transfer' (between his own accounts), 'card_payment' (a card bill), 'wallet_topup' with wallet (money from his bank or card into one of his wallets: a wallet's id, e.g. 'grabpay' — line_id only; the line stops being spending and the wallet's balance goes up; give credit when the shop gave bonus credit: what he got, e.g. paid 200 and got 240 → credit '240' (default: the shop's usual deal if the ledger knows one — e.g. 350 per 300 — else the amount paid); saying it again on a line already a top-up just changes the credit; 'grabpay_topup' still means wallet_topup to grabpay), or 'spending' (it is spending after all). Give kind and EITHER merchant — part of a payee's name; every line of the matching payees (at most 15), now and in future, takes that kind and no automatic rule changes it — OR line_id for one line only. None but spending is ever in a spending total.",
			inputSchema: {
				kind: z.enum(["spending", "investment", "loan_repayment", "friend_transfer", "own_transfer", "card_payment", "wallet_topup", "grabpay_topup"]).optional(),
				wallet: z.string().optional().describe("With kind wallet_topup: which wallet the money went into — its id, e.g. 'grabpay'"),
				credit: amountText("With kind wallet_topup: the credit he got for this top-up when the shop gave a bonus, e.g. '240' for pay 200 get 240 (at least what he paid, at most twice it)").optional(),
				merchant: z.string().optional().describe("Part of the payee's name, e.g. 'Acme Broker'"),
				line_id: z.string().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => setKindOp(op, args)),
	);

	server.registerTool(
		"ledger_income_offset",
		{
			title: "What an income offsets",
			description:
				"For money the owner received (an income line): to 'salary' (his pay: income, never spending), 'card' with account_id (it reduces that credit card's spending), 'line' with target_line_id (it pays back that purchase: its net cost, category and trip go down), or 'none' (ordinary income again).",
			inputSchema: {
				line_id: z.string().describe("The income line's id"),
				to: z.enum(OFFSET_TARGETS),
				account_id: z.string().optional().describe("For 'card': the card's id or part of its name, e.g. '5507'"),
				target_line_id: z.string().optional().describe("For 'line': the purchase it pays back"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => incomeOffsetOp(op, args.line_id, args)),
	);

	server.registerTool(
		"ledger_confirm_trip",
		{
			title: "Trips",
			description:
				"action 'list' shows proposed and confirmed trips. 'create' starts the owner's own trip (name, start_date, end_date, optional destination, include_line_ids): its overseas spending in those dates joins by itself. With trip_id: 'confirm' (optionally with corrected name/dates/lines), 'dismiss' (not a trip), 'restore' (undo a dismiss), or 'edit' (name, start_date, end_date, include_line_ids, exclude_line_ids — the owner's choices beat the automatic ones).",
			inputSchema: {
				action: z.enum(TRIP_ACTIONS),
				trip_id: z.string().optional().describe("A trip's id, or part of its name or destination"),
				name: z.string().nullable().optional(),
				start_date: date("First day of the trip").optional(),
				end_date: date("Last day of the trip").optional(),
				destination: z.string().optional().describe("For create: where, e.g. 'Japan'"),
				include_line_ids: z.array(z.string()).optional(),
				exclude_line_ids: z.array(z.string()).optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => tripOp(op, args)),
	);

	server.registerTool(
		"ledger_bills",
		{
			title: "Card bills",
			description:
				"Each credit card's newest bill: statement balance, paid since, still to pay, due date, days left and status — paid, due, overdue (with status_reason), autopay_pending (paid by auto-debit from an account the ledger does not track; confirmed by the next statement, never overdue on its own) or unknown — plus what the newest statement says about the bill before (previous_bill). Call with nothing to see every card, or card alone for one. To record the owner's word: card with paid true (he paid its newest bill; the ledger cannot see the payment — the next statement still checks it) or paid false (take that back); and/or autopay true (paid by auto-debit), false (he pays it himself) or null (let the statements decide).",
			inputSchema: {
				card: z.string().optional().describe("A card's id, name, last 4 digits or bank (e.g. '5502', 'HSBC')"),
				paid: z.boolean().optional().describe("The owner says he paid this card's newest bill (true), or takes that back (false)"),
				autopay: z.boolean().nullable().optional().describe("true = paid by auto-debit; false = the owner pays it himself; null = decide from the statements"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => billsOp(op, args)),
	);

	server.registerTool(
		"ledger_subscriptions",
		{
			title: "Subscriptions",
			description:
				"Recurring charges the ledger detected, with price changes, next renewal and the monthly total in his home currency. status 'all' includes lapsed and set-aside ones. To change one: subscription_id (or part of the merchant name) with action 'ignore' (not a subscription — never proposed again), 'cancelled' (the owner stopped it), 'active' (still running, whatever detection says) or 'restore' (back to detection).",
			inputSchema: {
				status: z.enum(["active", "all"]).optional(),
				subscription_id: z.string().optional(),
				action: z.enum(SUBSCRIPTION_ACTIONS).optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => runTool(env, deps, (op) => subscriptionsOp(op, args)),
	);

	return server;
}

/// /mcp, after the OAuth library has accepted the token. The props it carries
/// must still be the owner's: if LEDGER_OWNER_EMAIL ever changes, a token
/// issued to the old address stops working at once, not when it expires.
export async function handleMcp(request: Request, env: LedgerEnv, ctx: Ctx, deps: Deps): Promise<Response> {
	const notSetUp = useHome(env);
	if (notSetUp) return fail(503, NOT_SET_UP(notSetUp));
	const props = (ctx.props ?? {}) as { email?: unknown };
	const owner = normalizeEmail(env.LEDGER_OWNER_EMAIL);
	if (!owner || typeof props.email !== "string" || normalizeEmail(props.email) !== owner) return fail(403, "this ledger belongs to someone else");
	// A Ledger Reader token (reader-mcp.ts) reads tasks; it never reaches the ledger's own tools.
	if ((props as { aud?: unknown }).aud === "reader") return fail(403, "this sign-in is for the Ledger Reader, not the Ledger connector");
	const server = buildServer(env, deps);
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: LEDGER_MCP_LIMITS.maxRequestBodySize });
	await server.connect(transport);
	return transport.handleRequest(request);
}
