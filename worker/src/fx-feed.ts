/// Daily exchange rates. The ledger values a foreign
/// purchase at the day's market rate until the statement says what the bank
/// actually billed, so it keeps two years of rates for the owner's currencies,
/// each against his HOME currency (src/home.ts).
///
///   * The ECB's reference rates, through Frankfurter (free, no key): ONE
///     call for a whole date range, with the home currency as the base. Stored
///     as X → home (1 / the home-based value). Only when the ECB publishes the
///     home currency itself (ECB_CURRENCIES); otherwise every rate comes from
///     the fallback below.
///   * Currencies the ECB does not publish (TWD) from the open currency-api
///     (jsDelivr, with its pages.dev mirror), the home currency's own page, one
///     call per day — at most 60 days a tick while catching up.
///   * Up to 500 rates per statement (json_each), so two years cost a handful
///     of queries. A feed that is down is tried again later; no alarm — the
///     engine already looks back up to 7 days for a rate.
///   * Older history on demand: when the backfill is extended to older months
///     (extend.ts), the days before the earliest one held are filled first —
///     the ECB in one call, the rest a day at a time — and `from` records the
///     new earliest day.

import { addDays, addMonths } from "../../src/dates";
import { homeCurrency } from "../../src/home";
import type { Step, Tick } from "./tick";

/// Kept when LEDGER_FX_CURRENCIES is unset, less the home currency itself.
export const DEFAULT_FX_CURRENCIES = ["USD", "EUR", "JPY", "GBP", "AUD", "CNY", "HKD", "KRW", "THB", "MYR", "IDR", "TWD", "SGD"];
/// What the ECB publishes reference rates for (Frankfurter's list), EUR included.
export const ECB_CURRENCIES: ReadonlySet<string> = new Set(["AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"]);
export const ROWS_PER_STATEMENT = 500;
export const OTHER_DAYS_PER_TICK = 60;
/// Once caught up, the feed is checked at most this often.
export const RECHECK_MS = 6 * 3_600_000;

export interface FxState {
	ecb_through: string | null; // last day asked of the ECB feed
	other_through: string | null; // last day fetched from the fallback feed
	missing: string[] | null; // currencies the ECB does not publish (learned on the first call)
	checked_at: string | null;
	failed_at?: string | null; // a feed did not answer: wait RETRY_MS before asking again
	from?: string | null; // the earliest day held (unset: what the finished backfill's fill reached, heldFrom)
	older?: OlderFill | null; // filling days before `from`, in progress
}

/// Filling `from`..`to` (the day before the earliest held), resumable.
interface OlderFill {
	from: string;
	to: string;
	ecb: boolean;
	other_through: string | null;
}

export const RETRY_MS = 15 * 60_000;

interface Rate {
	d: string;
	c: string;
	r: number;
	s: string;
}

export function fxCurrencies(value: string | undefined): string[] {
	const home = homeCurrency();
	const list = value?.trim() ? value.split(",").map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)) : DEFAULT_FX_CURRENCIES;
	return [...new Set(list)].filter((c) => c !== home);
}

/// The first day rates are kept for: the backfill's reach plus a month.
export function fxStart(today: string, months: number): string {
	return `${addMonths(today, -(months + 1)).slice(0, 7)}-01`;
}

export function backfillMonths(t: Tick): number {
	const n = Number(t.env.LEDGER_BACKFILL_MONTHS);
	return Number.isInteger(n) && n > 0 && n <= 60 ? n : 24;
}

/// The first day of rates the reading of `month` (YYYY-MM) and later needs:
/// two months before it, the same reach fxStart gives the backfill.
export function fxFromFor(month: string): string {
	return `${addMonths(`${month}-01`, -2).slice(0, 7)}-01`;
}

/// The earliest day the history holds: recorded by an older fill, else the
/// reach of the finished backfill's own fill (fxStart for its oldest month —
/// the feed may hold more; asking again for a day held is harmless).
function heldFrom(t: Tick, s: FxState): string | null {
	if (s.from) return s.from;
	const oldest = t.get<{ months?: string[] }>("backfill")?.months?.at(-1);
	return oldest ? fxFromFor(oldest) : null;
}

/// Does the rate history reach back to `day`?
export function fxReaches(t: Tick, day: string): boolean {
	const s = t.get<FxState>("fx");
	const held = s ? heldFrom(t, s) : null;
	return held !== null && held <= day;
}

/// Fill the days from `from` up to the earliest one held. "nothing" = already
/// held; "worked" = this tick did (or tried) a piece of it.
async function fillOlder(t: Tick, from: string, wanted: readonly string[]): Promise<"nothing" | "worked"> {
	const state: FxState = { ecb_through: null, other_through: null, missing: null, checked_at: null, ...(t.get<FxState>("fx") ?? {}) };
	const held = heldFrom(t, state);
	if (!held || held <= from) return "nothing";
	if (state.failed_at && t.now().getTime() - new Date(state.failed_at).getTime() < RETRY_MS) return "worked";
	const to = addDays(held, -1);
	let older: OlderFill = state.older && state.older.from === from && state.older.to === to ? state.older : { from, to, ecb: false, other_through: null };
	const missing = state.missing ?? [];
	if (!older.ecb) {
		const symbols = ECB_CURRENCIES.has(homeCurrency()) ? wanted.filter((c) => ECB_CURRENCIES.has(c) && !missing.includes(c)) : [];
		const rates: Rate[] = [];
		if (symbols.length) {
			const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
			if (!t.room(4 + Math.ceil(days * symbols.length / ROWS_PER_STATEMENT))) return "worked";
			const r = await getJson(t, `https://api.frankfurter.dev/v1/${from}..${to}?base=${homeCurrency()}&symbols=${symbols.join(",")}`);
			if (r.status !== 404 && (r.status !== 200 || !r.body)) {
				t.count("fx_unavailable");
				t.putLater("fx", { ...state, failed_at: t.iso() });
				return "worked";
			}
			for (const [d, row] of Object.entries((r.body as { rates?: Record<string, Record<string, number>> } | null)?.rates ?? {}))
				for (const [c, v] of Object.entries(row)) if (typeof v === "number" && v > 0 && symbols.includes(c) && d >= from && d <= to) rates.push({ d, c, r: 1 / v, s: "ecb" });
		}
		older = { ...older, ecb: true };
		await save(t, rates, { ...state, failed_at: null, older });
		t.count("fx_older_ecb");
	}
	if (missing.length && (older.other_through ?? "") < to) {
		if (!t.room(3 + Math.ceil(OTHER_DAYS_PER_TICK * missing.length / ROWS_PER_STATEMENT))) return "worked";
		let day = older.other_through ? addDays(older.other_through, 1) : from;
		const rates: Rate[] = [];
		let n = 0;
		while (day <= to && n < OTHER_DAYS_PER_TICK && t.timeLeft()) {
			const got = await otherDay(t, day, missing);
			if (got === null) break;
			if (got !== "skip") rates.push(...got);
			older = { ...older, other_through: day };
			day = addDays(day, 1);
			n++;
		}
		if (!n) {
			t.count("fx_unavailable");
			t.putLater("fx", { ...state, ...t.get<FxState>("fx"), failed_at: t.iso() });
			return "worked";
		}
		await save(t, rates, { ...state, ...t.get<FxState>("fx"), older });
		if ((older.other_through ?? "") < to) return "worked";
	}
	// Both feeds reach `from`: it is the new earliest day held.
	await save(t, [], { ...state, ...t.get<FxState>("fx"), from, older: null });
	t.count("fx_older_filled");
	return "worked";
}

async function save(t: Tick, rates: readonly Rate[], state: FxState): Promise<void> {
	const statements = [];
	for (let i = 0; i < rates.length; i += ROWS_PER_STATEMENT) {
		statements.push(
			t.db
				.prepare(
					"INSERT OR REPLACE INTO fx_rates (date, currency, quote, rate, source) " +
						"SELECT json_extract(value, '$.d'), json_extract(value, '$.c'), ?, json_extract(value, '$.r'), json_extract(value, '$.s') FROM json_each(?)",
				)
				.bind(homeCurrency(), JSON.stringify(rates.slice(i, i + ROWS_PER_STATEMENT))),
		);
	}
	statements.push(t.put("fx", state));
	await t.db.batch(statements);
	if (rates.length) t.count("fx_rates", rates.length);
}

async function getJson(t: Tick, url: string): Promise<{ status: number; body: unknown }> {
	try {
		const res = await t.deps.fetch(url, { headers: { Accept: "application/json" } });
		return { status: res.status, body: res.ok ? await res.json() : null };
	} catch {
		return { status: 0, body: null };
	}
}

/// The ECB range: one call. Returns false if the feed did not answer.
async function ecbRange(t: Tick, from: string, to: string, through: string, wanted: readonly string[], state: FxState): Promise<boolean> {
	// A home currency the ECB does not publish: it has no base to ask with. Every
	// rate is then the fallback feed's, and the ECB is never called.
	if (!ECB_CURRENCIES.has(homeCurrency())) {
		await save(t, [], { ...state, ecb_through: through, missing: state.missing ?? [...wanted] });
		return true;
	}
	// What the ECB does not publish is the fallback feed's from the start (never asked of the ECB).
	const notEcb = wanted.filter((c) => !ECB_CURRENCIES.has(c));
	const symbols = wanted.filter((c) => ECB_CURRENCIES.has(c) && !(state.missing ?? []).includes(c));
	if (!symbols.length) {
		if (state.missing === null || state.missing === undefined) state = { ...state, missing: notEcb };
		await save(t, [], { ...state, ecb_through: through });
		return true;
	}
	const r = await getJson(t, `https://api.frankfurter.dev/v1/${from}..${to}?base=${homeCurrency()}&symbols=${symbols.join(",")}`);
	// 404: no rates at all in the range (a holiday weekend). Nothing to store.
	if (r.status === 404) {
		await save(t, [], { ...state, ecb_through: through });
		return true;
	}
	if (r.status !== 200 || !r.body) {
		t.count("fx_unavailable");
		return false;
	}
	const days = (r.body as { rates?: Record<string, Record<string, number>> }).rates ?? {};
	const rates: Rate[] = [];
	const seen = new Set<string>();
	for (const [d, row] of Object.entries(days)) {
		for (const [c, v] of Object.entries(row)) {
			if (typeof v === "number" && v > 0 && symbols.includes(c)) {
				rates.push({ d, c, r: 1 / v, s: "ecb" });
				seen.add(c);
			}
		}
	}
	const missing = state.missing ?? (Object.keys(days).length ? [...notEcb, ...symbols.filter((c) => !seen.has(c))] : null);
	await save(t, rates, { ...state, ecb_through: through, missing });
	return true;
}

/// One day from the fallback feed, for the currencies the ECB lacks.
async function otherDay(t: Tick, date: string, missing: readonly string[]): Promise<Rate[] | "skip" | null> {
	const base = homeCurrency().toLowerCase();
	const urls = [`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${base}.json`, `https://${date}.currency-api.pages.dev/v1/currencies/${base}.json`];
	let notFound = 0;
	for (const url of urls) {
		const r = await getJson(t, url);
		if (r.status === 404) {
			notFound++;
			continue;
		}
		if (r.status !== 200 || !r.body) continue;
		const page = (r.body as Record<string, Record<string, number> | undefined>)[base] ?? {};
		return missing.flatMap((c) => {
			const v = page[c.toLowerCase()];
			return typeof v === "number" && v > 0 ? [{ d: date, c, r: 1 / v, s: "currency-api" }] : [];
		});
	}
	// Both say the day does not exist (before the feed began): move past it.
	return notFound === urls.length ? "skip" : null;
}

export const fxFeed: Step = {
	name: "fx",
	async run(t) {
		const today = t.today();
		const yesterday = addDays(today, -1);
		const start = fxStart(today, backfillMonths(t));
		// The older months' reading (extend.ts) asked for history before what is held: that first.
		const extra = t.get<{ fx_from?: string; done?: boolean }>("backfill_extra");
		if (extra && !extra.done && extra.fx_from && (await fillOlder(t, extra.fx_from, fxCurrencies(t.env.LEDGER_FX_CURRENCIES))) === "worked") return;
		let state: FxState = { ecb_through: null, other_through: null, missing: null, checked_at: null, ...(t.get<FxState>("fx") ?? {}) };
		const caughtUp = state.ecb_through !== null && state.ecb_through >= yesterday && (state.other_through ?? "") >= yesterday;
		if (caughtUp && state.checked_at && t.now().getTime() - new Date(state.checked_at).getTime() < RECHECK_MS) return;
		if (state.failed_at && t.now().getTime() - new Date(state.failed_at).getTime() < RETRY_MS) return;
		const wanted = fxCurrencies(t.env.LEDGER_FX_CURRENCIES);
		state = { ...state, checked_at: t.iso() };

		// The ECB: from the day after the last one recorded, up to today. Only
		// yesterday is recorded as done, so today is asked again next check
		// (the ECB publishes in the European afternoon).
		if (t.room(4 + Math.ceil(800 * wanted.length / ROWS_PER_STATEMENT))) {
			const from = state.ecb_through && state.ecb_through >= start ? (state.ecb_through >= yesterday ? yesterday : addDays(state.ecb_through, 1)) : start;
			if (!(await ecbRange(t, from, today, yesterday, wanted, { ...state, failed_at: null }))) {
				t.putLater("fx", { ...state, failed_at: t.iso() });
				return;
			}
			state = { ...state, ...t.get<FxState>("fx") };
		}

		// The rest, a day at a time.
		if (state.missing === null) return; // not known until the ECB has answered with rates
		const missing = state.missing;
		if (!missing.length) {
			if (state.other_through !== yesterday) await save(t, [], { ...state, other_through: yesterday });
			return;
		}
		let day = state.other_through && state.other_through >= start ? addDays(state.other_through, 1) : start;
		const rates: Rate[] = [];
		let n = 0;
		while (day <= today && n < OTHER_DAYS_PER_TICK && t.timeLeft()) {
			const got = await otherDay(t, day, missing);
			if (got === null) break;
			if (got !== "skip") rates.push(...got);
			state.other_through = day === today ? yesterday : day;
			day = addDays(day, 1);
			n++;
		}
		if (n && t.room(2 + Math.ceil(rates.length / ROWS_PER_STATEMENT))) await save(t, rates, state);
		else if (!n) {
			t.count("fx_unavailable");
			t.putLater("fx", { ...state, failed_at: t.iso() });
		}
	},
};

/// Have rates been filled back to the backfill's reach (the backfill waits for this)?
export function fxFilled(t: Tick): boolean {
	const s = t.get<FxState>("fx");
	const yesterday = addDays(t.today(), -1);
	return !!s && s.ecb_through !== null && s.ecb_through >= yesterday && (s.missing?.length === 0 || (s.other_through ?? "") >= yesterday);
}
