/// Monthly reconciliation, and the two flags that come out of a statement.
///
/// The rule depends on the account (the owner):
///   * credit card — the month's ledger lines must equal the statement's total
///     to the cent. "Total" = the net movement the statement prints (new
///     charges − credits − payments), or, if it prints only balances,
///     closing − opening.
///   * bank account (and the DBS debit card, whose spending lives on it) —
///     opening balance − money out + money in = closing balance, to the cent.
///   * cash — never reconciled.
/// Any failure marks the month 'escalated' (sent to the senior model), with the
/// reasons kept in statements.recon_detail_json.

import { addDays } from "./dates";
import type { Account, AccountKind, Evidence, EvidenceType, LineRow, ReconStatus, Statement } from "./types";

export type ReconCode =
	| "not_reconcilable" // a debit card or cash has no statement of its own
	| "no_total" // credit card statement with neither a printed total nor both balances
	| "no_balances" // bank statement without opening AND closing balance
	| "printed_total_disagrees" // the statement's printed total ≠ its own balances
	| "statement_lines_mismatch" // the statement's own lines do not add up: a parsing problem
	| "ledger_mismatch" // the ledger does not add up to the statement
	| "unmatched_statement_line" // a statement line with no ledger line
	| "line_in_review" // a line on this statement is still being looked at
	| "estimate_on_statement" // a posted line still carries an estimate
	| "currency_mismatch" // a line billed in a different currency from the statement
	| "bill_mismatch" // round 2: previous − payments + purchases − refunds + fees ≠ the bill's new balance
	| "wallet_balance_mismatch"; // a wallet statement's closing balance ≠ the balance the ledger works out

export interface ReconProblem {
	code: ReconCode;
	message: string;
	ids?: string[];
}

export interface ReconResult {
	ok: boolean;
	rule: "card_total" | "bank_balance" | "wallet_balance" | "none";
	expected_minor: number | null;
	ledger_minor: number;
	statement_lines_minor: number;
	difference_minor: number | null; // ledger − expected
	line_count: number;
	problems: ReconProblem[];
}

/// The amount a statement line moves the account by, in the statement's currency.
export function statementLineAmount(ev: Pick<Evidence, "amount_minor" | "bill_minor">): number {
	return ev.bill_minor ?? ev.amount_minor;
}

/// `walletBalance` (a wallet only): the balance the ledger works out at the end
/// of the statement's last day — its cut-over balance, less everything out and
/// plus everything in since. A printed closing balance must equal it to the cent.
export function reconcileStatement(
	statement: Statement,
	accountKind: AccountKind,
	ledgerLines: readonly LineRow[],
	statementLines: readonly Evidence[],
	walletBalance: number | null = null,
): ReconResult {
	const lines = ledgerLines.filter((l) => l.state !== "void" && l.statement_id === statement.id);
	const ledger = lines.reduce((sum, l) => sum + l.bill_minor, 0);
	const printed = statementLines.reduce((sum, ev) => sum + statementLineAmount(ev), 0);
	const problems: ReconProblem[] = [];
	const { opening_balance_minor: open, closing_balance_minor: close, printed_net_minor: net } = statement;

	let rule: ReconResult["rule"] = "none";
	let expected: number | null = null;
	if (accountKind === "credit_card") {
		rule = "card_total";
		// A card balance is what he OWES, so debt going up is money out (+).
		const fromBalances = open !== null && close !== null ? close - open : null;
		expected = net ?? fromBalances;
		if (expected === null) problems.push({ code: "no_total", message: "the statement prints no total and not both balances" });
		if (net !== null && fromBalances !== null && net !== fromBalances) {
			problems.push({ code: "printed_total_disagrees", message: `printed total ${net} ≠ closing − opening ${fromBalances}` });
		}
	} else if (accountKind === "bank") {
		rule = "bank_balance";
		// A bank balance is what he HOLDS, so money out (+) makes it go down:
		// opening − Σ(lines) = closing  ⇔  Σ(lines) = opening − closing.
		if (open === null || close === null) {
			problems.push({ code: "no_balances", message: "a bank statement needs both its opening and closing balance" });
		} else {
			expected = open - close;
			if (net !== null && net !== expected) {
				problems.push({ code: "printed_total_disagrees", message: `printed net ${net} ≠ opening − closing ${expected}` });
			}
		}
	} else if (accountKind === "wallet") {
		// A wallet holds money like a bank: opening − money out + money in = closing.
		// Its statement (GrabPay's, daily) may print no balances: then its lines are
		// matched one by one and the month stands on those alone.
		rule = "wallet_balance";
		if (open !== null && close !== null) expected = open - close;
		else if (net !== null) expected = net;
		if (close !== null && walletBalance !== null && close !== walletBalance) {
			problems.push({ code: "wallet_balance_mismatch", message: `the statement's closing balance ${close} ≠ the balance the ledger works out ${walletBalance}` });
		}
	} else {
		problems.push({ code: "not_reconcilable", message: `a ${accountKind} has no statement of its own` });
	}

	if (expected !== null && printed !== expected) {
		problems.push({
			code: "statement_lines_mismatch",
			message: `the statement's own lines add to ${printed}, its total says ${expected}`,
		});
	}
	if (expected !== null && ledger !== expected) {
		problems.push({ code: "ledger_mismatch", message: `the ledger adds to ${ledger}, the statement to ${expected}` });
	}
	const lineIds = new Set(lines.map((l) => l.id));
	const unmatched = statementLines.filter((ev) => !ev.line_id || !lineIds.has(ev.line_id));
	if (unmatched.length) {
		problems.push({ code: "unmatched_statement_line", message: `${unmatched.length} statement line(s) have no ledger line`, ids: unmatched.map((e) => e.id) });
	}
	const inReview = lines.filter((l) => l.state === "review");
	if (inReview.length) problems.push({ code: "line_in_review", message: `${inReview.length} line(s) under review`, ids: inReview.map((l) => l.id) });
	const estimates = lines.filter((l) => l.bill_status === "estimate");
	if (estimates.length) {
		problems.push({ code: "estimate_on_statement", message: `${estimates.length} posted line(s) still estimated`, ids: estimates.map((l) => l.id) });
	}
	const wrongCcy = lines.filter((l) => l.bill_currency !== statement.currency);
	if (wrongCcy.length) {
		problems.push({ code: "currency_mismatch", message: `${wrongCcy.length} line(s) not billed in ${statement.currency}`, ids: wrongCcy.map((l) => l.id) });
	}

	return {
		ok: problems.length === 0,
		rule,
		expected_minor: expected,
		ledger_minor: ledger,
		statement_lines_minor: printed,
		difference_minor: expected === null ? null : ledger - expected,
		line_count: lines.length,
		problems,
	};
}

export function reconStatusFor(result: ReconResult): ReconStatus {
	return result.ok ? "reconciled" : "escalated";
}

// ----------------------------------------------------------------- the flags

/// A purchase normally posts within this many days. A statement closing at
/// least this long after the purchase should carry it.
export const POSTING_LAG_DAYS = 5;
/// A wallet's statement is daily (GrabPay): a purchase is on the statement of
/// its own day, or of the next one when it was made near midnight.
export const WALLET_LAG_DAYS = 1;

/// The account whose statement carries this account's lines: itself, or the
/// bank account a debit card settles to. null = never on a statement.
export function statementAccountId(account: Account): string | null {
	if (account.kind === "debit_card") return account.settles_to;
	if (account.kind === "cash" || account.has_statements === 0) return null;
	return account.id;
}

/// The owner's rule: an estimate still unconfirmed after its statement is flagged.
/// Applied to every alert-only line, because an SGD line its statement skipped
/// is just as worth a look (usually a reversed authorisation — a hotel hold).
/// `statements` = the statements of statementAccountId(account). Only a
/// statement whose period reaches back to when the line should have posted
/// counts : a line from before the first statement the ledger has —
/// a card whose older bills the owner never uploaded — is not "missing" from a
/// later one. (No period_start given = the old rule: any later closing.)
export function isNotOnStatement(
	line: Pick<LineRow, "statement_id" | "state" | "txn_date">,
	statements: readonly (Pick<Statement, "period_end"> & Partial<Pick<Statement, "period_start">>)[],
	lagDays = POSTING_LAG_DAYS,
): boolean {
	if (line.statement_id !== null || line.state === "void") return false;
	const due = addDays(line.txn_date, lagDays);
	return statements.some((s) => s.period_end >= due && (s.period_start === undefined || s.period_start <= due));
}

/// A statement line no alert ever told us about. Still recorded — just marked.
export function isMissedByAlerts(account: Pick<Account, "alerts_expected">, attached: ReadonlySet<EvidenceType>): boolean {
	return account.alerts_expected === 1 && attached.has("statement_line") && !attached.has("alert");
}
