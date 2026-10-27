/// How complete each account's lines are — so the page never implies zero
/// spending where the ledger simply has not been told yet (the owner).
///
///   'live'            — email alerts arrive within minutes (DBS, HSBC, Citi).
///   'statement_only'  — no email alerts (台新 sends phone pushes only). Lines
///                       are complete up to the last statement; after it, only
///                       Apple Pay taps the shortcut reported appear.
///   'manual'          — cash: only what the owner adds.
///   'wallet'          — a stored-value wallet (GrabPay, Sample Bistro): recorded from its
///                       cut-over date; the top-ups before it were counted as
///                       spending then, so nothing is missing (src/wallet.ts).
///
/// Every total the page or the connector shows for a period must carry the
/// coverage of the accounts in it (CONTRACT.md §5.6).

import { addDays, addMonths } from "./dates";
import type { Money } from "./money";
import { statementAccountId } from "./reconcile";
import type { Account, Statement } from "./types";
import { takesSms, toldOnly, type WalletState } from "./wallet";
import { say } from "./words";

export type CoverageMode = "live" | "statement_only" | "manual" | "wallet";

export interface Coverage {
	account_id: string;
	mode: CoverageMode;
	/// Lines are complete through this date (the last statement's closing
	/// date). null for 'live' (complete to today) and when no statement exists yet.
	complete_through: string | null;
	last_statement_date: string | null;
	last_tap_date: string | null; // newest Apple Pay shortcut evidence
	/// True when a period ending `asOf` may be missing spending. For a
	/// statement-only card that is EVERY day between two statements — normal,
	/// not trouble: the spending after `complete_through` comes with the next
	/// statement. Never show it as zero. Trouble is `overdue`.
	partial: boolean;
	/// A statement-only card: about when its next statement closes (the last
	/// one + a month, on the card's cut-off day when known). null otherwise.
	next_statement_due?: string | null;
	/// That next statement is more than OVERDUE_GRACE_DAYS late by `asOf`:
	/// something is wrong (the only case the page shows as a warning).
	overdue?: boolean;
	/// What the ledger knows about why, when it is overdue (null: nothing found).
	overdue_reason?: OverdueReason | null;
	message: string; // plain English, ready to show (a wallet's in Chinese, the owner's words)
	/// A wallet only: recorded since, what is in it now, and how much of the
	/// balance already counted as spending at top-up is still unspent.
	/// told_only: no statements and no mail (Sample Bistro) — the balance is only what the owner told.
	/// balance is the shop's CREDIT; remaining_value what that credit is worth in money (SGD), prepaid
	/// and not used yet (19 Oct 2026) — of which precounted_left was already counted as spending at old top-ups.
	wallet?: { since: string; balance: Money; precounted_left: Money; remaining_value: Money; told_only: boolean } | null;
}

/// Days after its expected closing date before a statement counts as late:
/// the bank emails it a few days after the cut-off (台新 ~2–5 days).
export const OVERDUE_GRACE_DAYS = 10;

/// Why an overdue statement is not in, as far as the ledger can tell:
///   pdf_password  the bank's statement PDF would not open (alarm pdf_password:<BANK>)
///   read_failed   a statement email from that bank could not be read (it is in 待確認)
///   reading       a statement email from that bank has arrived and is still being read
///   no_mail       no statement email from that bank since `since` (the last one's arrival)
export interface OverdueReason {
	kind: "pdf_password" | "read_failed" | "reading" | "no_mail";
	since: string | null; // YYYY-MM-DD
}

/// The next statement's closing date: a month after the last one, on the
/// card's cut-off day when it has one (clamped to the month's end).
export function nextStatementDue(last: string, statementDay: number | null | undefined): string {
	return addMonths(last, 1, statementDay && statementDay >= 1 && statementDay <= 31 ? statementDay : undefined);
}

export function accountCoverage(
	account: Account,
	statements: readonly Pick<Statement, "account_id" | "period_end">[],
	lastTapDate: string | null,
	asOf: string,
	/// Cards this one replaced (a lost card): their statements count as its own (round 2).
	predecessors: readonly string[] = [],
	/// A wallet's balance (src/wallet.ts walletStates).
	walletState: WalletState | null = null,
	/// When the next statement is overdue: why, as far as the ledger knows (queries.ts coverageFor).
	overdueReason: OverdueReason | null = null,
): Coverage {
	if (account.kind === "wallet") {
		const since = account.wallet_since ?? walletState?.since ?? "";
		return {
			account_id: account.id,
			mode: "wallet",
			complete_through: null,
			last_statement_date: statements.filter((s) => s.account_id === account.id).map((s) => s.period_end).sort().at(-1) ?? null,
			last_tap_date: null,
			partial: false,
			// A wallet with no statements and no mail (Sample Bistro) knows only what the owner tells it.
			// A shop that texts after each use (範例): its SMS are read and its balance checked against them.
			message: takesSms(account)
				? say("coverage.wallet_sms", { name: account.name })
				: toldOnly(account)
					? say("coverage.wallet_told", { name: account.name })
					: say("coverage.wallet_since", { name: account.name, since }),
			wallet: walletState ? { since, balance: walletState.balance, precounted_left: walletState.precounted_left, remaining_value: walletState.remaining_value, told_only: toldOnly(account) } : null,
		};
	}
	const own = statementAccountId(account);
	const last = statements
		.filter((s) => s.account_id === own || (own !== null && predecessors.includes(s.account_id)))
		.map((s) => s.period_end)
		.sort()
		.at(-1) ?? null;
	const mode: CoverageMode = account.kind === "cash" ? "manual" : account.alerts_expected === 1 ? "live" : "statement_only";

	if (mode === "live") {
		return { account_id: account.id, mode, complete_through: null, last_statement_date: last, last_tap_date: lastTapDate, partial: false, message: say("coverage.live", { name: account.name }) };
	}
	if (mode === "manual") {
		return { account_id: account.id, mode, complete_through: null, last_statement_date: null, last_tap_date: null, partial: false, message: say("coverage.manual", { name: account.name }) };
	}
	const partial = last === null || last < asOf;
	const taps = lastTapDate && (last === null || lastTapDate > last) ? say("coverage.taps_after") : "";
	if (last === null) {
		const message = say(lastTapDate ? "coverage.none_taps" : "coverage.none_nothing", { name: account.name });
		return { account_id: account.id, mode, complete_through: null, last_statement_date: null, last_tap_date: lastTapDate, partial, next_statement_due: null, overdue: false, overdue_reason: null, message };
	}
	const due = nextStatementDue(last, account.statement_day);
	const overdue = asOf > addDays(due, OVERDUE_GRACE_DAYS);
	const reason = overdue ? overdueReason : null;
	const message = !partial
		? say("coverage.complete", { name: account.name, last })
		: overdue
			? say("coverage.late", { name: account.name, last, taps, due, reason: reasonText(reason) })
			: say("coverage.between", { name: account.name, last, taps, due });
	return { account_id: account.id, mode, complete_through: last, last_statement_date: last, last_tap_date: lastTapDate, partial, next_statement_due: due, overdue, overdue_reason: reason, message };
}

function reasonText(r: OverdueReason | null): string {
	switch (r?.kind) {
		case "pdf_password":
			return say("coverage.late_pdf");
		case "read_failed":
			return say("coverage.late_unread");
		case "reading":
			return say("coverage.late_reading");
		case "no_mail":
			return r.since ? say("coverage.late_no_mail", { since: r.since }) : say("coverage.late_no_mail_ever");
		default:
			return say("coverage.late_unknown");
	}
}
