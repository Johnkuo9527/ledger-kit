/// Alarms: trouble the owner must hear about — on his page (GET /api/status) and in
/// the email. Raising an open alarm again only refreshes its message; raising
/// a cleared one re-opens it (and it may be emailed again).

import type { Bound, Db } from "../../src/db";
import { localDate } from "../../src/home";
import type { Estimate } from "./dryrun";
import type { LedgerEnv } from "./env";
import { readerStatus, type ReaderStatus } from "./reader";
import { BACKFILL_SPEND_SUFFIX, CATCHUP_SPEND_SUFFIX, DEFAULT_DAILY_CAP_USD, DEFAULT_MAIL_RESERVE_USD, EXTRA_SPEND_SUFFIX } from "./tick";

export type AlarmKey = "home_changed" | "no_banks" | "credit_exhausted" | "credit_low" | "key_rejected" | "google_signin" | "backfill_cap" | "backfill_extra_cap" | "model_unavailable" | "catchup_cap" | "mail_stuck" | "mail_check_late" | "reader_idle" | `pdf_password:${string}` | `bank_unverified:${string}` | `bank_sender_unknown:${string}` | `wallet_unverified:${string}` | `alerts_silent:${string}`;

export interface Alarm {
	key: string;
	message: string;
	raised_at: string;
	cleared_at: string | null;
	notified_at: string | null;
}

/// Alarms worth an email the moment they are raised, not only on Monday.
export const URGENT: ReadonlySet<string> = new Set(["credit_exhausted", "key_rejected", "google_signin"]);

export function raiseAlarm(db: Db, key: AlarmKey, message: string, now: string): Bound {
	return db
		.prepare(
			"INSERT INTO alarms (key, message, raised_at, cleared_at, notified_at) VALUES (?, ?, ?, NULL, NULL) " +
				"ON CONFLICT (key) DO UPDATE SET message = excluded.message, " +
				"raised_at = CASE WHEN alarms.cleared_at IS NULL THEN alarms.raised_at ELSE excluded.raised_at END, " +
				"notified_at = CASE WHEN alarms.cleared_at IS NULL THEN alarms.notified_at ELSE NULL END, cleared_at = NULL",
		)
		.bind(key, message, now);
}

export function clearAlarm(db: Db, key: AlarmKey, now: string): Bound {
	return db.prepare("UPDATE alarms SET cleared_at = ? WHERE key = ? AND cleared_at IS NULL").bind(now, key);
}

export async function openAlarms(db: Db): Promise<Alarm[]> {
	return (await db.prepare("SELECT * FROM alarms WHERE cleared_at IS NULL ORDER BY raised_at, key").bind().all<Alarm>()).results;
}

export interface RunRow {
	id: string;
	kind: string;
	started_at: string;
	finished_at: string | null;
	ok: 0 | 1 | null;
	counts_json: string | null;
	error: string | null;
}

/// What the page shows about the engine itself: is it running, what is wrong.
export interface EngineStatus {
	alarms: { key: string; message: string; raised_at: string }[];
	/// The last tick that did any work, as the run log has it. Never assumed.
	last_run: { kind: string; started_at: string; finished_at: string | null; ok: boolean | null; error: string | null } | null;
	/// When the one-minute tick last held the lock: the heartbeat.
	last_tick_at: string | null;
	phase: "not_started" | "dry_run" | "awaiting_approval" | "backfill" | "daily";
	queue: { waiting: number; failed: number };
	/// The dry run's cost estimate, once the counting is done (until the backfill starts it is what the owner approves).
	estimate: Estimate | null;
	/// The older months' reading (extend.ts), once started: which months, how
	/// many are read, what it has spent of its approval. Null: never started.
	older_months: { from: string; to: string; read: number; total: number; spent_usd: number; done: boolean } | null;
	/// Read-only, so a stall is visible (13 Oct 2026): when Gmail was
	/// last checked, the unfinished work by source / stage / kind, and today's
	/// spend against each cap.
	diagnostic: Diagnostic;
	/// Who reads the mail (LEDGER_READER) and, in subscription mode, the readings
	/// waiting for the owner's Claude routines: by tier, and the last answer's time.
	reader: ReaderStatus;
}

export interface Diagnostic {
	/// The last mail check that finished (every listed message queued); null = none yet.
	gmail_checked_at: string | null;
	/// A mail check started but not finished (Gmail not answering?), or null.
	gmail_check_running_since: string | null;
	/// The owner's day of the last daily pull (the net under the mail check).
	daily_pull_day: string | null;
	/// Work not done: per source ("daily", "backfill", "owner_upload"), stage and kind (null = not yet sorted), with the oldest's queue time.
	work: { source: string; stage: string; kind: string | null; count: number; oldest: string | null }[];
	/// Today (the owner's day) against each cap, in US$.
	spend_today: { day: string; daily_usd: number; daily_cap_usd: number; mail_reserve_usd: number; catchup_usd: number; older_months_usd: number; backfill_usd: number };
	/// The catching up's approval (uploads, bills read again): a total, never reset.
	catchup: { approved_usd: number; spent_usd: number };
}

function usd(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}
const cents = (n: number) => Math.round(n * 100) / 100;

/// Ten queries, whatever the size of the ledger (the diagnostic's two and the reader's two included).
export async function engineStatus(db: Db, opts: { env?: LedgerEnv; today?: string } = {}): Promise<EngineStatus> {
	// Every query at once (20 Oct 2026): one round trip, not nine.
	const stateP = db
		.prepare("SELECT key, value FROM sync_state WHERE key IN ('run_lock', 'phase', 'dry_run', 'backfill_extra', 'backfill_extra_spent', 'mail_check', 'daily_pull', 'catchup_spent')")
		.bind()
		.all<{ key: string; value: string }>()
		.then((r) => r.results);
	const [alarms, run, state, queue, diag, reader] = await Promise.all([
		openAlarms(db),
		db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").bind().first<RunRow>(),
		stateP,
		db
			.prepare("SELECT SUM(CASE WHEN stage IN ('new', 'ingest', 'parked', 'waiting') THEN 1 ELSE 0 END) AS waiting, SUM(CASE WHEN stage = 'failed' THEN 1 ELSE 0 END) AS failed FROM work")
			.bind()
			.first<{ waiting: number | null; failed: number | null }>(),
		diagnostic(db, stateP, opts),
		readerStatus(db, opts.env),
	]);
	const lock = state.find((s) => s.key === "run_lock")?.value;
	return {
		alarms: alarms.map((a) => ({ key: a.key, message: a.message, raised_at: a.raised_at })),
		last_run: run ? { kind: run.kind, started_at: run.started_at, finished_at: run.finished_at, ok: run.ok === null ? null : run.ok === 1, error: run.error } : null,
		last_tick_at: lock ? ((JSON.parse(lock) as { at?: string }).at ?? null) : null,
		phase: (state.find((s) => s.key === "phase")?.value as EngineStatus["phase"] | undefined) ?? "not_started",
		queue: { waiting: queue?.waiting ?? 0, failed: queue?.failed ?? 0 },
		estimate: (() => {
			const raw = state.find((s) => s.key === "dry_run")?.value;
			return raw ? ((JSON.parse(raw) as { estimate?: Estimate | null }).estimate ?? null) : null;
		})(),
		older_months: (() => {
			const raw = state.find((s) => s.key === "backfill_extra")?.value;
			if (!raw) return null;
			const x = JSON.parse(raw) as { months: string[]; i: number; done: boolean };
			const spent = Number(state.find((s) => s.key === "backfill_extra_spent")?.value ?? 0) || 0;
			return { from: x.months.at(-1) ?? "", to: x.months[0] ?? "", read: x.done ? x.months.length : Math.min(x.i, x.months.length), total: x.months.length, spent_usd: Math.round(spent * 100) / 100, done: x.done };
		})(),
		diagnostic: diag,
		reader,
	};
}

/// Two queries: the unfinished work, grouped, and today's spend by model — sent
/// with the state they read, not after it.
async function diagnostic(db: Db, stateP: Promise<{ key: string; value: string }[]>, opts: { env?: LedgerEnv; today?: string }): Promise<Diagnostic> {
	const day = opts.today ?? localDate(new Date());
	const [state, work, spent] = await Promise.all([
		stateP,
		db
			.prepare("SELECT source, stage, kind, COUNT(*) AS count, MIN(created_at) AS oldest FROM work WHERE stage IN ('new', 'waiting', 'ingest', 'parked', 'failed') GROUP BY source, stage, kind ORDER BY source, stage, kind")
			.bind()
			.all<{ source: string; stage: string; kind: string | null; count: number; oldest: string | null }>()
			.then((r) => r.results),
		db.prepare("SELECT model, usd FROM api_spend WHERE day = ?").bind(day).all<{ model: string; usd: number }>().then((r) => r.results),
	]);
	const json = <T>(key: string): T | null => {
		const raw = state.find((s) => s.key === key)?.value;
		if (!raw) return null;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return null;
		}
	};
	const check = json<{ started_at?: string; ok_at?: string | null; done?: boolean }>("mail_check");
	const sum = (f: (model: string) => boolean) => cents(spent.filter((r) => f(r.model)).reduce((n, r) => n + r.usd, 0));
	const env = opts.env;
	return {
		gmail_checked_at: check?.ok_at ?? null,
		gmail_check_running_since: check && !check.done ? (check.started_at ?? null) : null,
		daily_pull_day: json<{ day?: string }>("daily_pull")?.day ?? null,
		work,
		spend_today: {
			day,
			daily_usd: sum((m) => !m.endsWith(EXTRA_SPEND_SUFFIX) && !m.endsWith(CATCHUP_SPEND_SUFFIX) && !m.endsWith(BACKFILL_SPEND_SUFFIX)),
			daily_cap_usd: usd(env?.LEDGER_DAILY_SPEND_CAP_USD, DEFAULT_DAILY_CAP_USD),
			mail_reserve_usd: usd(env?.LEDGER_DAILY_MAIL_RESERVE_USD, DEFAULT_MAIL_RESERVE_USD),
			catchup_usd: sum((m) => m.endsWith(CATCHUP_SPEND_SUFFIX)),
			older_months_usd: sum((m) => m.endsWith(EXTRA_SPEND_SUFFIX)),
			backfill_usd: sum((m) => m.endsWith(BACKFILL_SPEND_SUFFIX)),
		},
		catchup: { approved_usd: usd(env?.LEDGER_CATCHUP_APPROVED_USD, 0), spent_usd: cents(Number(state.find((s) => s.key === "catchup_spent")?.value ?? 0) || 0) },
	};
}
