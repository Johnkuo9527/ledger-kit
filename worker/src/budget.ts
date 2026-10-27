/// The per-tick D1 query budget (the owner's decision).
///
/// The owner is on Workers Paid: one invocation may make 1,000 D1 queries. The
/// page and the connector keep the connector's 40 (test/budget.test.ts). The cron tick
/// gets ONE setting, the var LEDGER_TICK_D1_BUDGET (default 400), and this
/// wrapper enforces it: every query is counted (a batch counts each of its
/// statements), and work stops before the setting is passed.
///
/// The last RESERVE queries are kept for closing the tick (the run log, the
/// spend log, releasing the lock), so the tick always finishes honestly.
/// `test/tick-budget.test.ts` proves no tick ever passes the setting.

import type { Bound, Db, RunResult, Stmt } from "../../src/db";

export const DEFAULT_TICK_BUDGET = 400;
/// Closing a tick: the runs row, the spend upsert, the alarm sweep, the lock.
export const RESERVE = 6;
/// Cloudflare's own ceiling on Workers Paid; a setting above it is refused.
export const D1_HARD_LIMIT = 1000;

export class BudgetExhausted extends Error {
	constructor(readonly used: number, readonly limit: number) {
		super(`D1 query budget for this tick reached (${used} of ${limit})`);
	}
}

export function tickBudget(value: string | undefined): number {
	const n = Number(value);
	if (!value || !Number.isInteger(n) || n < 40) return DEFAULT_TICK_BUDGET;
	return Math.min(n, D1_HARD_LIMIT);
}

/// A Db that counts and refuses past its limit. `closing()` opens the reserve.
export class BudgetDb implements Db {
	used = 0;
	private limit: number;
	constructor(
		private inner: Db,
		readonly total: number,
	) {
		this.limit = total - RESERVE;
	}

	/// Queries left before work must stop (the reserve is not counted).
	remaining(): number {
		return Math.max(0, this.limit - this.used);
	}

	/// Keep at least `n` queries for closing (never fewer than RESERVE): the
	/// tick grows it when alarms or state writes are queued for its close.
	setReserve(n: number): void {
		if (this.limit !== this.total) this.limit = this.total - Math.max(RESERVE, n);
	}

	/// Queries the closing batch may still use.
	left(): number {
		return Math.max(0, this.total - this.used);
	}

	/// From here on only the closing writes run; they may use the reserve.
	closing(): void {
		this.limit = this.total;
	}

	private take(n: number): void {
		if (this.used + n > this.limit) throw new BudgetExhausted(this.used, this.limit);
		this.used += n;
	}

	prepare(sql: string): Stmt {
		const stmt = this.inner.prepare(sql);
		return {
			bind: (...values: unknown[]): Bound => {
				const b = stmt.bind(...values);
				const counted: Bound & { inner: Bound } = {
					inner: b,
					first: <T>() => (this.take(1), b.first<T>()),
					all: <T>() => (this.take(1), b.all<T>()),
					run: () => (this.take(1), b.run()),
				};
				return counted;
			},
		};
	}

	async batch(statements: Bound[]): Promise<RunResult[]> {
		this.take(statements.length);
		return this.inner.batch(statements.map((s) => (s as Bound & { inner?: Bound }).inner ?? s));
	}
}
