/// What the worker is given by Cloudflare, and what the tests give it instead.
///
/// Secrets (`npx wrangler secret put <NAME>`, never in a file — INSTALL.md has
/// the exact commands). Each is checked where it is used; a missing one makes
/// that one door say "not set up yet", never open.
///
///   LEDGER_UNLOCK_KEY      the long random key in the owner's "open my ledger" link
///   LEDGER_SESSION_SECRET  signs the page's cookie; rotating it signs every
///                          browser out — the whole recovery plan for a lost phone
///   LEDGER_SHORTCUT_KEY    the Apple Pay shortcut's own key (CONTRACT.md §6.6):
///                          separate, so a lost phone is cut off without locking
///                          The owner out of his page
///   LEDGER_OWNER_EMAIL     the ONLY address the connector's sign-in sends a
///                          code to; the ledger is one person's
///   RESEND_API_KEY         sends that code (and, the weekly email)
///
/// The daily engine adds its own: LEDGER_PDF_PW_<BANK>, ANTHROPIC_API_KEY, the Gmail
/// client (CONTRACT.md §10). The Gmail refresh token comes from 「連接 Gmail」
/// (google.ts, stored encrypted); GMAIL_REFRESH_TOKEN is only the old fallback.

import type { Db } from "../../src/db";
import { homeFromVars, setHome, type HomeVars } from "../../src/home";
import { languageFrom, languageProblem, setLanguage } from "../../src/words";

/// The owner's home, chosen at install (wrangler.toml [vars], scripts/setup.sh):
///   LEDGER_HOME_CURRENCY  ISO 4217, the currency every total is in (SGD, EUR, USD, JPY …)
///   LEDGER_TIMEZONE       IANA, the zone every "day" is counted in (Asia/Singapore, Europe/London …)
///   LEDGER_HOME_COUNTRY   ISO 3166 alpha-2, where "abroad" starts (trips, overseas fees)
/// All three are required: a worker without them refuses every door (useHome).
/// And the owner's language (src/words.ts), the words of the page, the alarms,
/// the Shortcut replies and the connector's messages:
///   LEDGER_LANGUAGE       "en" (the default when unset) or "zh-Hant"
export interface LedgerEnv extends InstallVars {
	LEDGER_DB: Db;
	/// The OAuth library's store (clients, grants, tokens). Typed by the library.
	OAUTH_KV?: unknown;
	LEDGER_UNLOCK_KEY?: string;
	LEDGER_SESSION_SECRET?: string;
	LEDGER_SHORTCUT_KEY?: string;
	LEDGER_OWNER_EMAIL?: string;
	RESEND_API_KEY?: string;
	/// A var, not a secret: who the sign-in email is from.
	LEDGER_MAIL_FROM?: string;

	// ---- The daily engine (INSTALL.md)
	ANTHROPIC_API_KEY?: string;
	/// Who reads the mail (13 Oct 2026): "api" (the default) calls the
	/// Claude API with ANTHROPIC_API_KEY; "subscription" calls no model at all —
	/// every reading waits as a task for the owner's own Claude subscription (his
	/// "Ledger Reader" routines, through /mcp-reader).
	LEDGER_READER?: string;
	GMAIL_CLIENT_ID?: string;
	GMAIL_CLIENT_SECRET?: string;
	/// Optional since 「連接 Gmail」: used only when no connection is saved (google.ts).
	GMAIL_REFRESH_TOKEN?: string;
	// LEDGER_PDF_PW_<BANK> / LEDGER_PDF_PW_<ACCOUNT>: read by name (pdfPassword()).
	/// Vars (wrangler.toml): the model ids, never written in code (CONTRACT §7).
	LEDGER_MODEL_SENIOR?: string;
	LEDGER_MODEL_DAILY?: string;
	/// Seconds of wall clock after which a tick starts no new work, default 480.
	LEDGER_TICK_WALL_SECONDS?: string;
	/// D1 queries one cron tick may make (budget.ts), default 400.
	LEDGER_TICK_D1_BUDGET?: string;
	/// US$ the daily reading may spend on Claude per day (the owner's day), default 3.
	LEDGER_DAILY_SPEND_CAP_USD?: string;
	/// Receipts (mail not from a bank) the daily reading sends to the model per day, default 30.
	LEDGER_RECEIPTS_PER_DAY?: string;
	/// The owner's approval of the dry run's estimate, and the backfill's spend cap. Unset = not approved.
	LEDGER_BACKFILL_APPROVED_USD?: string;
	/// The owner's approval for reading OLDER months after the backfill finished
	/// (LEDGER_BACKFILL_MONTHS raised later, extend.ts), and that reading's own
	/// spend cap — a total across every extension. Unset = not approved.
	LEDGER_BACKFILL_EXTRA_APPROVED_USD?: string;
	/// The owner's approval for one-off catching up — the statements he uploads and
	/// the statements the look back reads once more — and its own spend cap, a
	/// total (never reset) like the older months'. Unset = not approved: those
	/// wait (alarm catchup_cap); new mail is never affected.
	LEDGER_CATCHUP_APPROVED_USD?: string;
	/// US$ of the daily cap kept for reading NEW bank alerts, default 1.
	LEDGER_DAILY_MAIL_RESERVE_USD?: string;
	/// Comma-separated sender domains for the Gmail search, until the playbook names senders.
	LEDGER_GMAIL_DOMAINS?: string;
	/// Comma-separated currencies to keep daily rates for (fx-feed.ts).
	LEDGER_FX_CURRENCIES?: string;
	/// The API credit the owner last topped up to, the day he did, and the "running low" line.
	LEDGER_IGNORE_SUBJECTS?: string;
	LEDGER_CATEGORIES?: string;
	LEDGER_API_CREDIT_USD?: string;
	LEDGER_API_CREDIT_SINCE?: string;
	LEDGER_API_CREDIT_LOW_USD?: string;
	/// Months the dry run and the backfill reach back, default 24, counted from the
	/// month the backfill started. Raised after the backfill finished: the extra
	/// older months are read (extend.ts).
	LEDGER_BACKFILL_MONTHS?: string;
}

/// A worker secret looked up by its name (the PDF passwords). Never logged.
export function secretNamed(env: LedgerEnv, name: string): string | undefined {
	const v = (env as unknown as Record<string, unknown>)[name];
	return typeof v === "string" && v ? v : undefined;
}

export interface InstallVars extends HomeVars {
	LEDGER_LANGUAGE?: string;
}

/// Set the owner's home and language for this request from the install's vars
/// (src/home.ts, src/words.ts). A string = why the ledger is not set up; every
/// entry (page, connectors, tap, tick) then refuses rather than count money in a
/// currency or a day it guessed, or speak a language nobody chose.
export function useHome(env: InstallVars): string | null {
	const h = homeFromVars(env);
	const lang = languageProblem(env.LEDGER_LANGUAGE);
	if (typeof h === "string") return lang ? `${h}; ${lang}` : h;
	if (lang) return lang;
	setHome(h);
	setLanguage(languageFrom(env.LEDGER_LANGUAGE));
	return null;
}

export const NOT_SET_UP = (why: string) => `This ledger is not set up yet: ${why}. Set it in wrangler.toml [vars] (scripts/setup.sh writes it) and deploy again.`;

/// The slice of Cloudflare's ExecutionContext this worker uses. The OAuth
/// library puts the signed-in person's props on it before /mcp runs.
export interface Ctx {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException?(): void;
	props?: unknown;
}

/// Everything time-, chance- or network-shaped, so a test can pin it.
export interface Deps {
	now(): Date;
	newId(): string;
	/// The pause after a wrong key. Tests pass one that does not wait.
	sleep(ms: number): Promise<void>;
	fetch: typeof fetch;
}

export const realDeps: Deps = {
	now: () => new Date(),
	newId: () => crypto.randomUUID(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	fetch: (input, init) => fetch(input, init),
};

/// Every secret this worker relies on must be at least this long: 32 random
/// characters is out of reach of guessing. INSTALL.md mints them with
/// `openssl rand -hex 32` (64 characters).
export const MIN_SECRET_LENGTH = 32;

export function strongSecret(value: string | undefined): value is string {
	return typeof value === "string" && value.length >= MIN_SECRET_LENGTH;
}

/// LEDGER_READER: "subscription" only when it says so exactly (any other value,
/// or none, keeps today's API reading).
export function readerMode(env: Pick<LedgerEnv, "LEDGER_READER">): "api" | "subscription" {
	return (env.LEDGER_READER ?? "").trim().toLowerCase() === "subscription" ? "subscription" : "api";
}
