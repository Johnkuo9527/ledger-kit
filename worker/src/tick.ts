/// The one-minute cron tick: everything the daily engine does, in small,
/// budgeted pieces.
///
///   * One tick at a time: a lease in sync_state ('run_lock'), 15 minutes, so
///     a tick that dies is taken over by the next one. A tick that finds the
///     lock held leaves after ONE query.
///   * Every query goes through BudgetDb (LEDGER_TICK_D1_BUDGET, default 400);
///     running out is a normal stop — the next tick carries on.
///   * No new piece of work starts after 8 minutes of wall clock.
///   * The close always runs (finally): the spend log, the alarms raised or
///     cleared, the state the steps queued, the run log (only when the tick did
///     something) and the lock release, in ONE batch inside the reserve.
///   * A step that fails is logged and the next step still runs: a broken FX
///     feed never stops the bank alerts being read.

import { say } from "../../src/words";
import { BankList, BANKS_KEY } from "../../src/bank-list";
import { readHead, type PlaybookHead } from "../../src/playbook-store";
import type { Bound } from "../../src/db";
import type { Alarm, AlarmKey } from "./alarms";
import { BudgetDb, BudgetExhausted, tickBudget } from "./budget";
import { makeClient, SpendCap, type ClaudeClient, type Failure } from "./claude";
import { NOT_SET_UP, readerMode, realDeps, useHome, type Deps, type LedgerEnv } from "./env";
import { homeCurrency, localDate, localHour, localWeekday } from "../../src/home";
import { GmailError, type Mail } from "./gmail";
import { gmailFromLink, LINK_KEY } from "./google";

export const LOCK_LEASE_MS = 15 * 60_000;
/// sync_state: the home currency the ledger's amounts are in (written by the first tick).
export const HOME_KEY = "home_currency";
/// No new piece of work starts after this much wall clock (var
/// LEDGER_TICK_WALL_SECONDS). Default 8 minutes, for a 15-minute cron limit.
/// TO VERIFY before go-live: Cloudflare's wall-time limit for a
/// cron that fires EVERY MINUTE; if it is shorter, lower the var to fit.
export const WALL_CLOCK_MS = 8 * 60_000;

export function wallClockMs(value: string | undefined): number {
	const n = Number(value);
	return value && Number.isFinite(n) && n >= 10 && n <= 840 ? n * 1000 : WALL_CLOCK_MS;
}
/// A refused key or exhausted credit pauses model work this long.
export const MAX_PDFS_PER_TICK = 20;
export const MODEL_PAUSE_MS = 60 * 60_000;
export const DEFAULT_DAILY_CAP_USD = 3;
/// Of the daily allowance, this much (US$) is kept for reading NEW bank alerts:
/// everything else the daily reading pays for (statements, receipts, sorting
/// merchants, patterns, escalations) stops this far short of the cap
/// (var LEDGER_DAILY_MAIL_RESERVE_USD; 13 Oct 2026).
export const DEFAULT_MAIL_RESERVE_USD = 1;

/// The google_signin alarm, on the page (with its 「重新連接 Gmail」 button) and in the email.
export const googleSigninMessage = () =>
	`Google refused the ledger's sign-in to your Gmail, so no new emails are being read. Open your ledger page and tap ${say("ui.reconnect_gmail")} (the address /google/connect on your ledger). Nothing is lost: it catches up on the days it missed.`;

export type Phase = "dry_run" | "awaiting_approval" | "backfill" | "daily";

/// Whose money a model call is: "main" (the daily cap, or the backfill's
/// approval while the backfill runs), "extra" (the extended backfill of
/// older months, extend.ts: LEDGER_BACKFILL_EXTRA_APPROVED_USD) or "catchup"
/// (one-off catching up: statements the owner uploads and statements the look back
/// reads again — LEDGER_CATCHUP_APPROVED_USD, a total like "extra"'s).
/// "daily" is today's mail (13 Oct 2026): always the daily allowance,
/// even while the backfill runs — so a backfill paused at its approval never
/// stops new mail being read.
export type Pot = "main" | "daily" | "extra" | "catchup";
/// The money a call actually spends, whatever pot it was asked under.
export type Purse = "daily" | "backfill" | "extra" | "catchup";
/// Which part of the work a "main" call is for: "mail" = reading a new bank
/// alert (may use the whole daily allowance), "other" = everything else (stops
/// short of it by the mail reserve).
export type Lane = "mail" | "other";
/// The extended backfill's calls are logged in api_spend under this suffix, so
/// the daily cap (today's spend) leaves them out while the credit check counts them.
export const EXTRA_SPEND_SUFFIX = " (older months)";
/// The same for the catching up (uploads, statements read again).
export const CATCHUP_SPEND_SUFFIX = " (catch-up)";
/// The same for the backfill (its own approval): the daily allowance never pays for it.
export const BACKFILL_SPEND_SUFFIX = " (backfill)";
const SPEND_SUFFIX: Record<Purse, string> = { daily: "", backfill: BACKFILL_SPEND_SUFFIX, extra: EXTRA_SPEND_SUFFIX, catchup: CATCHUP_SPEND_SUFFIX };

/// The slice of the Gmail client the engine uses (tests hand in a fake).
export interface MailSource {
	list(q: string, pageToken?: string, max?: number): Promise<{ ids: string[]; next: string | null }>;
	message(id: string): Promise<Mail>;
	attachment(messageId: string, attachmentId: string): Promise<Uint8Array>;
}

export interface Services {
	claude?: ClaudeClient | null;
	gmail?: MailSource | null;
	/// Builds the Gmail reader once the tick holds the lock and has loaded
	/// sync_state: it is handed the `google_link` row (the token saved by
	/// 「連接 Gmail」, google.ts). Used only when `gmail` is not given.
	gmailFor?: (link: string | undefined) => Promise<MailSource | null>;
}

export function liveServices(env: LedgerEnv, deps: Deps = realDeps): Services {
	return {
		claude: env.ANTHROPIC_API_KEY ? makeClient(env.ANTHROPIC_API_KEY) : null,
		gmail: null,
		gmailFor: env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET ? (link) => gmailFromLink(env, deps, link) : undefined,
	};
}

export interface Step {
	name: string;
	run(t: Tick): Promise<void>;
}

function num(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/// What every step is handed: the budgeted database, the clock, the state,
/// and the queue of writes for the close.
export class Tick {
	readonly db: BudgetDb;
	readonly started: number;
	readonly state = new Map<string, string>();
	readonly alarms = new Map<string, Alarm>();
	readonly counts: Record<string, number> = {};
	readonly errors: string[] = [];
	/// Statements the close must write (state, alarms), in order.
	private closeQueue = new Map<string, Bound>();
	private spendLoaded: { today: number; since: number } | null = null;
	/// Paid for, but its write was refused mid-tick: the close writes it.
	private unlogged: Record<string, { model: string; purse: Purse; usd: number; calls: number }> = {};
	private capObjs: Partial<Record<Purse, SpendCap>> = {};
	private headCache: PlaybookHead | null | undefined;
	/// Model work stops for the rest of this tick (credit gone, key refused…).
	modelStopped = false;
	/// One purse's cap was reached: only its calls stop for this tick
	/// ("daily:other": the daily allowance down to its mail reserve — new bank
	/// alerts may still be read).
	private potStopped = new Set<Purse | "daily:other">();
	/// The pot the next model call is charged to (set around one unit by withPot).
	pot: Pot = "main";
	/// The lane of the next "main" call (set around one alert by withLane).
	lane: Lane = "other";
	/// Run first thing in the close (e.g. the backfill adding this tick's spend to its total).
	readonly onClose: (() => void)[] = [];
	/// CPU guard: Cloudflare gives a cron that fires more often than hourly 30 s
	/// of CPU (wall time is 15 min; waiting on Gmail or Claude is wall, not CPU).
	/// Opening a statement PDF is the only heavy CPU (14–190 ms each), so a tick
	/// opens at most MAX_PDFS_PER_TICK of them — under 4 s at the worst seen.
	pdfsLeft = MAX_PDFS_PER_TICK;
	/// LEDGER_READER = "subscription" (13 Oct 2026): no model is
	/// called from here at all. Every reading becomes a task in reading_tasks
	/// that the owner's own Claude subscription answers (reader.ts, /mcp-reader);
	/// spend caps and spend approvals do not apply.
	readonly subscription: boolean;
	/// The work row (gmail_id) the next reading is for, so a reader's answer
	/// can wake it at once (set around one unit by the work queue).
	readingFor: string | null = null;
	/// Gmail work stops for the rest of this tick (Google not answering).
	gmailStopped = false;
	did = false;

	constructor(
		readonly env: LedgerEnv,
		readonly deps: Deps,
		readonly svc: Services,
		budget: number,
	) {
		this.db = new BudgetDb(env.LEDGER_DB, budget);
		this.started = deps.now().getTime();
		this.wallMs = wallClockMs(env.LEDGER_TICK_WALL_SECONDS);
		this.subscription = readerMode(env) === "subscription";
	}
	readonly wallMs: number;

	now(): Date {
		return this.deps.now();
	}
	iso(): string {
		return this.deps.now().toISOString();
	}
	/// The owner's date and hour (src/home.ts: his time zone, daylight saving and all).
	today(): string {
		return localDate(this.now());
	}
	localHour(): number {
		return localHour(this.now());
	}
	/// 0 = Sunday … 6 = Saturday, on the owner's calendar.
	localWeekday(): number {
		return localWeekday(this.now());
	}
	timeLeft(): boolean {
		return this.now().getTime() - this.started < this.wallMs;
	}
	/// Is there room for a piece of work needing `need` queries?
	room(need: number): boolean {
		return this.timeLeft() && this.db.remaining() >= need;
	}
	count(name: string, n = 1): void {
		this.counts[name] = (this.counts[name] ?? 0) + n;
		this.did = true;
	}

	// ---------------------------------------------------------------- state
	get<T>(key: string): T | undefined {
		const raw = this.state.get(key);
		if (raw === undefined) return undefined;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return raw as T;
		}
	}
	/// A sync_state write to put in the caller's own batch (strings stored raw).
	put(key: string, value: unknown): Bound {
		const raw = typeof value === "string" ? value : JSON.stringify(value);
		this.state.set(key, raw);
		this.closeQueue.delete(`state:${key}`);
		this.syncReserve();
		return this.db
			.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
			.bind(key, raw, this.iso());
	}
	/// A sync_state write the close makes (when it does not need to be atomic with other work).
	putLater(key: string, value: unknown): void {
		const b = this.put(key, value);
		this.closeQueue.set(`state:${key}`, b);
		this.syncReserve();
	}
	phase(): Phase | null {
		return (this.state.get("phase") as Phase | undefined) ?? null;
	}

	// --------------------------------------------------------------- alarms
	isOpen(key: string): boolean {
		return this.alarms.has(key);
	}
	raise(key: AlarmKey, message: string): void {
		if (this.alarms.get(key)?.message === message) return;
		const at = this.iso();
		this.alarms.set(key, { key, message, raised_at: at, cleared_at: null, notified_at: null });
		this.closeQueue.set(`alarm:${key}`, this.db
			.prepare(
				"INSERT INTO alarms (key, message, raised_at, cleared_at, notified_at) VALUES (?, ?, ?, NULL, NULL) " +
					"ON CONFLICT (key) DO UPDATE SET message = excluded.message, " +
					"raised_at = CASE WHEN alarms.cleared_at IS NULL THEN alarms.raised_at ELSE excluded.raised_at END, " +
					"notified_at = CASE WHEN alarms.cleared_at IS NULL THEN alarms.notified_at ELSE NULL END, cleared_at = NULL",
			)
			.bind(key, message, at));
		this.syncReserve();
	}
	clear(key: AlarmKey): void {
		if (!this.alarms.has(key)) return;
		this.alarms.delete(key);
		this.closeQueue.set(`alarm:${key}`, this.db.prepare("UPDATE alarms SET cleared_at = ? WHERE key = ? AND cleared_at IS NULL").bind(this.iso(), key));
		this.syncReserve();
	}
	private syncReserve(): void {
		// runs row + spend rows (≤ 2 models) + lock + the queued writes
		this.db.setReserve(4 + this.closeQueue.size);
	}
	/// A write for the close, after everything queued before it (keyed: a later call replaces it).
	closeLater(key: string, statement: Bound): void {
		this.closeQueue.set(key, statement);
		this.syncReserve();
	}
	closeStatements(): Bound[] {
		return [...this.closeQueue.values()];
	}

	/// The owner's banks (src/bank-list.ts): his seed's list, kept in sync_state
	/// (already loaded — no query). Built once per tick.
	banks(): BankList {
		this.bankCache ??= BankList.from(this.state.get(BANKS_KEY));
		return this.bankCache;
	}
	private bankCache: BankList | undefined;

	/// The playbook's head (one query, once per tick; refreshed after a publish).
	async head(): Promise<PlaybookHead | null> {
		if (this.headCache === undefined) this.headCache = await readHead(this.db);
		return this.headCache;
	}
	forgetHead(): void {
		this.headCache = undefined;
	}

	// ---------------------------------------------------------------- money
	/// Today's spend and the spend since the last top-up (one query, once).
	async spend(): Promise<{ today: number; since: number }> {
		if (!this.spendLoaded) {
			const since = this.env.LEDGER_API_CREDIT_SINCE || "0000-00-00";
			const row = await this.db
				.prepare(
					"SELECT COALESCE(SUM(CASE WHEN day = ? AND substr(model, -length(?)) <> ? AND substr(model, -length(?)) <> ? AND substr(model, -length(?)) <> ? THEN usd END), 0) AS today, COALESCE(SUM(CASE WHEN day >= ? THEN usd END), 0) AS since FROM api_spend",
				)
				.bind(this.today(), EXTRA_SPEND_SUFFIX, EXTRA_SPEND_SUFFIX, CATCHUP_SPEND_SUFFIX, CATCHUP_SPEND_SUFFIX, BACKFILL_SPEND_SUFFIX, BACKFILL_SPEND_SUFFIX, since)
				.first<{ today: number; since: number }>();
			// Paid this tick but not yet written (a refused write): still spent.
			const pending = Object.values(this.unlogged).reduce((n, u) => n + u.usd, 0);
			const pendingMain = Object.values(this.unlogged).reduce((n, u) => n + (u.purse === "daily" ? u.usd : 0), 0);
			this.spendLoaded = { today: (row?.today ?? 0) + pendingMain, since: (row?.since ?? 0) + pending };
		}
		return this.spendLoaded;
	}
	/// What the backfill has spent of the owner's approval (its own state key, so a
	/// write of the backfill's progress can never wind it back).
	backfillSpent(): number {
		return Number(this.get<number>("backfill_spent") ?? 0) || 0;
	}
	/// What the extended backfill (older months) has spent of its own approval.
	extraSpent(): number {
		return Number(this.get<number>("backfill_extra_spent") ?? 0) || 0;
	}
	/// What the catching up (uploads, statements read again) has spent of its approval.
	catchupSpent(): number {
		return Number(this.get<number>("catchup_spent") ?? 0) || 0;
	}
	/// US$ of the daily allowance kept for new bank alerts.
	mailReserve(): number {
		return num(this.env.LEDGER_DAILY_MAIL_RESERVE_USD, DEFAULT_MAIL_RESERVE_USD);
	}
	/// Run `fn` with its "main" model calls in `lane`.
	async withLane<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
		const before = this.lane;
		this.lane = lane;
		try {
			return await fn();
		} finally {
			this.lane = before;
		}
	}
	/// The money the current pot spends: "main" is the backfill's approval while
	/// the backfill runs, else (like "daily") the daily allowance.
	purse(): Purse {
		const pot = this.pot;
		if (pot === "extra" || pot === "catchup") return pot;
		return pot === "main" && this.phase() === "backfill" ? "backfill" : "daily";
	}
	/// Run `fn` with its model calls charged to `pot`.
	async withPot<T>(pot: Pot, fn: () => Promise<T>): Promise<T> {
		const before = this.pot;
		this.pot = pot;
		try {
			return await fn();
		} finally {
			this.pot = before;
		}
	}
	/// A paid Claude call, written down AT ONCE — before any further work — so
	/// a tick Cloudflare stops part-way can never under-count the daily cap or
	/// the backfill's approval. If the write is refused, the close writes it.
	async recordSpend(model: string, usd: number): Promise<void> {
		const purse = this.purse();
		if (this.spendLoaded) {
			if (purse === "daily") this.spendLoaded.today += usd;
			this.spendLoaded.since += usd;
		}
		if (purse === "backfill") this.state.set("backfill_spent", String(this.backfillSpent() + usd));
		if (purse === "extra") this.state.set("backfill_extra_spent", String(this.extraSpent() + usd));
		if (purse === "catchup") this.state.set("catchup_spent", String(this.catchupSpent() + usd));
		try {
			await this.db.batch(this.spendWrites(model, purse, usd, 1));
		} catch (e) {
			console.error("tick: the spend write was refused; the close writes it", e);
			const u = (this.unlogged[`${purse}|${model}`] ??= { model, purse, usd: 0, calls: 0 });
			u.usd += usd;
			u.calls++;
		}
	}
	private spendWrites(model: string, purse: Purse, usd: number, calls: number): Bound[] {
		const at = this.iso();
		const add = (key: string, value: number) =>
			this.db
				.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS REAL) + CAST(excluded.value AS REAL) AS TEXT), updated_at = excluded.updated_at")
				.bind(key, String(value), at);
		return [
			this.db
				.prepare("INSERT INTO api_spend (day, model, usd, calls) VALUES (?, ?, ?, ?) ON CONFLICT (day, model) DO UPDATE SET usd = usd + excluded.usd, calls = calls + excluded.calls")
				.bind(this.today(), `${model}${SPEND_SUFFIX[purse]}`, usd, calls),
			...(purse === "backfill" ? [add("backfill_spent", usd)] : []),
			...(purse === "extra" ? [add("backfill_extra_spent", usd)] : []),
			...(purse === "catchup" ? [add("catchup_spent", usd)] : []),
		];
	}
	/// The close's share: only spend whose own write was refused.
	unloggedWrites(): Bound[] {
		return Object.values(this.unlogged).flatMap((u) => this.spendWrites(u.model, u.purse, u.usd, u.calls));
	}
	/// This tick's spend cap for the current purse: the daily allowance left, the
	/// backfill's approval left, the older months' approval left or the catching
	/// up's approval left. A daily-allowance call outside the mail lane must
	/// leave the mail reserve untouched.
	async cap(): Promise<SpendCap> {
		const purse = this.purse();
		let c = this.capObjs[purse];
		if (!c) {
			let usd: number;
			if (purse === "extra") usd = num(this.env.LEDGER_BACKFILL_EXTRA_APPROVED_USD, 0) - this.extraSpent();
			else if (purse === "catchup") usd = num(this.env.LEDGER_CATCHUP_APPROVED_USD, 0) - this.catchupSpent();
			else if (purse === "backfill") usd = num(this.env.LEDGER_BACKFILL_APPROVED_USD, 0) - this.backfillSpent();
			else usd = num(this.env.LEDGER_DAILY_SPEND_CAP_USD, DEFAULT_DAILY_CAP_USD) - (await this.spend()).today;
			c = this.capObjs[purse] = new SpendCap(Math.max(0, usd));
		}
		c.held = this.holdsReserve() ? this.mailReserve() : 0;
		return c;
	}
	/// Does the next call have to leave the mail reserve alone?
	private holdsReserve(): boolean {
		return this.purse() === "daily" && this.lane !== "mail" && (this.pot === "daily" || this.phase() === "daily");
	}
	/// What the current pot (and lane) could still pay, before any call (US$).
	async canPay(): Promise<number> {
		if (this.subscription) return Number.POSITIVE_INFINITY;
		const c = await this.cap();
		return Math.max(0, c.capUsd - c.spent - c.held);
	}
	/// Everything paid this tick, every pot together (null: no model was asked).
	spentThisTick(): Pick<SpendCap, "spent" | "byModel"> | null {
		const caps = Object.values(this.capObjs);
		if (!caps.length) return null;
		const byModel: SpendCap["byModel"] = {};
		for (const c of caps)
			for (const [model, m] of Object.entries(c.byModel)) {
				const into = (byModel[model] ??= { calls: 0, usd: 0, input: 0, output: 0, cache_read: 0 });
				into.calls += m.calls;
				into.usd += m.usd;
				into.input += m.input;
				into.output += m.output;
				into.cache_read += m.cache_read;
			}
		return { spent: caps.reduce((n, c) => n + c.spent, 0), byModel };
	}
	/// Can a model call be made at all right now?
	modelReady(model: string | undefined): model is string {
		if (this.subscription) return true;
		if (!model || !this.svc.claude || this.modelStopped || this.potStopped.has(this.purse())) return false;
		if (this.potStopped.has("daily:other") && this.holdsReserve()) return false;
		const paused = this.get<string>("model_paused_until");
		return !(paused && paused > this.iso());
	}
	/// Can a reading of this tier be asked for right now (a model call, or in
	/// subscription mode a reading task — always)?
	readerReady(tier: "daily" | "senior"): boolean {
		return this.subscription || this.modelReady(tier === "senior" ? this.env.LEDGER_MODEL_SENIOR : this.env.LEDGER_MODEL_DAILY);
	}
	/// A model call failed in a way that is about the run, not the item.
	modelFailure(failure: Failure): void {
		if (failure === "credit_exhausted" || failure === "key_rejected") {
			this.raise(failure, failure === "credit_exhausted" ? "Your Anthropic API credit has run out, so the ledger has stopped reading emails. Top it up at platform.claude.com → Billing; it starts again within the hour." : "The Anthropic API key was refused. Set a new ANTHROPIC_API_KEY; the ledger tries again within the hour.");
			this.putLater("model_paused_until", new Date(this.now().getTime() + MODEL_PAUSE_MS).toISOString());
			this.modelStopped = true;
		} else if (failure === "over_cap") {
			const purse = this.purse();
			if (purse === "extra") {
				this.potStopped.add("extra");
				this.raise("backfill_extra_cap", `Reading the older months has spent the US$${num(this.env.LEDGER_BACKFILL_EXTRA_APPROVED_USD, 0).toFixed(2)} you approved and has paused (the daily reading carries on). To let it finish, raise LEDGER_BACKFILL_EXTRA_APPROVED_USD.`);
				return;
			}
			if (purse === "catchup") {
				this.potStopped.add("catchup");
				this.raiseCatchupCap();
				return;
			}
			if (this.holdsReserve()) {
				// Only the work outside the mail lane stops: new bank alerts may still be read.
				this.potStopped.add("daily:other");
				return;
			}
			this.potStopped.add(purse);
			// The backfill step words it in full (what is left, what finishing costs); this is its first word.
			if (purse === "backfill" && !this.isOpen("backfill_cap"))
				this.raise("backfill_cap", "The two-year backfill has spent the amount you approved and has paused. New mail keeps being read meanwhile. To let it finish, raise LEDGER_BACKFILL_APPROVED_USD.");
		} else if (failure === "unavailable") {
			this.modelStopped = true;
			this.count("model_unavailable");
		}
	}
	modelSucceeded(): void {
		this.clear("credit_exhausted");
		this.clear("key_rejected");
		// Each pot's cap alarm is cleared only by a call of that pot (the daily
		// reading succeeding says nothing about the older months' approval, nor —
		// while the backfill runs — about the backfill's).
		const purse = this.purse();
		if (purse === "extra") this.clear("backfill_extra_cap");
		else if (purse === "catchup") this.clear("catchup_cap");
		else if (purse === "backfill" || this.phase() !== "backfill") this.clear("backfill_cap");
		if (this.state.has("model_paused_until")) this.putLater("model_paused_until", "");
	}

	/// The catching up cannot pay: the owner hears it on his page (new mail is not affected).
	raiseCatchupCap(): void {
		const approved = num(this.env.LEDGER_CATCHUP_APPROVED_USD, 0);
		this.raise(
			"catchup_cap",
			approved > 0
				? `Reading the statements you uploaded (and older bills being read once more) has spent the US$${approved.toFixed(2)} you approved and has paused. Your new bank emails are not affected. To let it finish, raise LEDGER_CATCHUP_APPROVED_USD.`
				: "Statements you uploaded (and older bills being read once more) are waiting for your approval to spend on reading them. Your new bank emails are not affected. To start, set LEDGER_CATCHUP_APPROVED_USD (see INSTALL.md, troubleshooting).",
		);
	}

	// ---------------------------------------------------------------- gmail
	/// A Gmail failure: sign-in trouble is the owner's to fix; anything else waits a tick.
	gmailFailure(e: unknown): void {
		if (!(e instanceof GmailError)) throw e;
		this.gmailStopped = true;
		if (e.kind === "signin_failed") this.raise("google_signin", googleSigninMessage());
	}
	gmailSucceeded(): void {
		this.clear("google_signin");
	}
}

/// Take the lock; null = another tick holds it (one query spent).
async function takeLock(t: Tick, holder: string): Promise<boolean> {
	const now = t.iso();
	const until = new Date(t.now().getTime() + LOCK_LEASE_MS).toISOString();
	const r = await t.db
		.prepare(
			"INSERT INTO sync_state (key, value, updated_at) VALUES ('run_lock', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at " +
				"WHERE json_extract(sync_state.value, '$.until') <= ?",
		)
		.bind(JSON.stringify({ holder, until, at: now }), now, now)
		.run();
	return r.meta.changes === 1;
}

/// Run one tick. Never throws: trouble is logged on the run row.
export async function runTick(env: LedgerEnv, deps: Deps, svc: Services, steps: readonly Step[]): Promise<{ ran: boolean; counts: Record<string, number>; queries: number; errors: string[] }> {
	const notSetUp = useHome(env);
	if (notSetUp) {
		console.error(`tick: ${NOT_SET_UP(notSetUp)}`);
		return { ran: false, counts: {}, queries: 0, errors: [notSetUp] };
	}
	// A copy: the Gmail reader is filled in below, never on the caller's object.
	const t = new Tick(env, deps, { ...svc }, tickBudget(env.LEDGER_TICK_D1_BUDGET));
	const holder = deps.newId();
	try {
		if (!(await takeLock(t, holder))) return { ran: false, counts: {}, queries: t.db.used, errors: [] };
	} catch (e) {
		console.error("tick: could not take the lock", e);
		return { ran: false, counts: {}, queries: t.db.used, errors: [String(e)] };
	}
	const runId = deps.newId();
	const startedAt = t.iso();
	try {
		const rows = (await t.db.prepare("SELECT key, value FROM sync_state").bind().all<{ key: string; value: string }>()).results;
		for (const r of rows) t.state.set(r.key, r.value);
		const open = (await t.db.prepare("SELECT * FROM alarms WHERE cleared_at IS NULL").bind().all<Alarm>()).results;
		for (const a of open) t.alarms.set(a.key, a);
		// Every stored amount is in the home currency the ledger started with:
		// changing LEDGER_HOME_CURRENCY afterwards would relabel them, not convert
		// them. The tick stops and says so until it is put back.
		const started = t.get<string>(HOME_KEY);
		if (started && started !== homeCurrency()) {
			t.raise("home_changed", `LEDGER_HOME_CURRENCY is now ${homeCurrency()}, but this ledger's amounts are all in ${started}. Nothing is being read until it is set back to ${started} in wrangler.toml [vars] (a ledger cannot change its home currency; start a new database for a new one).`);
			return { ran: true, counts: t.counts, queries: t.db.used, errors: t.errors };
		}
		// Recorded by the first tick that does anything (an idle tick stays at its few queries).
		if (!started) t.onClose.push(() => t.did && t.putLater(HOME_KEY, homeCurrency()));
		else t.clear("home_changed");
		if (!t.svc.gmail && t.svc.gmailFor) {
			// A broken saved connection must never stop the rest of the tick (FX, upkeep…).
			try {
				t.svc.gmail = await t.svc.gmailFor(t.state.get(LINK_KEY));
			} catch (e) {
				console.error("tick: could not open the saved Gmail connection", (e as Error)?.name);
			}
		}
		for (const step of steps) {
			if (!t.timeLeft()) break;
			try {
				await step.run(t);
			} catch (e) {
				if (e instanceof BudgetExhausted) break;
				t.did = true;
				t.errors.push(`${step.name}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
				console.error(`tick step ${step.name} failed`, e);
			}
		}
	} catch (e) {
		if (!(e instanceof BudgetExhausted)) {
			t.did = true;
			t.errors.push(`tick: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
		}
	} finally {
		await close(t, holder, runId, startedAt);
	}
	return { ran: true, counts: t.counts, queries: t.db.used, errors: t.errors };
}

async function close(t: Tick, holder: string, runId: string, startedAt: string): Promise<void> {
	t.db.closing();
	for (const hook of t.onClose) {
		try {
			hook();
		} catch (e) {
			console.error("tick: a close hook failed", e);
		}
	}
	const cap = t.spentThisTick();
	// Each paid call was written the moment it was paid (recordSpend); only a
	// write that was refused then is left for here.
	const spend: Bound[] = t.unloggedWrites();
	const byModel: Record<string, number> = {};
	for (const [model, m] of Object.entries(cap?.byModel ?? {})) byModel[model] = Math.round(m.usd * 1e6) / 1e6;
	const release = t.db
		.prepare("UPDATE sync_state SET value = json_set(value, '$.until', ?) WHERE key = 'run_lock' AND json_extract(value, '$.holder') = ?")
		.bind(t.iso(), holder);
	// Most important first, in case the budget is tighter than planned: the
	// spend log (money), the lock, the queued state, the run log, the alarms
	// (which a later tick raises again if the trouble is still there).
	const statements = [...spend, release, ...t.closeStatements()];
	if (t.did) {
		const counts = { ...t.counts, usd_by_model: byModel, d1_queries: t.db.used + statements.length + 1 };
		statements.push(
			t.db
				.prepare("INSERT INTO runs (id, kind, started_at, finished_at, ok, counts_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.bind(runId, t.phase() ?? "not_started", startedAt, t.iso(), t.errors.length ? 0 : 1, JSON.stringify(counts), t.errors.length ? t.errors.join(" | ").slice(0, 2000) : null),
		);
	}
	const fit = statements.slice(0, t.db.left());
	try {
		if (fit.length) await t.db.batch(fit);
	} catch (e) {
		// Never leave the lock held (or the money unlogged) because one
		// queued write was refused: try again with only those two.
		console.error("tick: the closing batch failed", e);
		try {
			await t.db.batch([...spend, release].slice(0, t.db.left()));
		} catch (e2) {
			console.error("tick: could not release the lock; the lease lapses in 15 minutes", e2);
		}
	}
}
