/// The owner's HOME: the currency every total is kept in and the time zone every
/// "day" is counted in. Chosen once, at install (wrangler.toml [vars]
/// LEDGER_HOME_CURRENCY and LEDGER_TIMEZONE, written by scripts/setup.sh), and
/// the same for every request: the worker sets it at each entry (homeFromEnv),
/// the tests with setHome.
///
/// This is the ONE place that turns an instant into the owner's calendar day or
/// clock. Everything else works on 'YYYY-MM-DD' strings (dates.ts), whose
/// arithmetic never needs a zone. Daylight saving is the zone database's job
/// (Intl.DateTimeFormat, which Workers and Node both carry): a fixed offset is
/// never assumed.
///
/// A home currency with 3 decimals (KWD, BHD …) is refused: the page and the
/// connector show totals with at most 2. A FOREIGN purchase in one is fine.

import { exponent, money, type Money } from "./money";

export interface Home {
	readonly currency: string; // ISO 4217, upper case
	readonly timeZone: string; // IANA, e.g. "Europe/Berlin"
	readonly country: string; // ISO 3166 alpha-2, upper case: where "abroad" starts (trips, overseas fees)
}

/// The kit's own first install. Tests that do not care use it.
export const SINGAPORE: Home = Object.freeze({ currency: "SGD", timeZone: "Asia/Singapore", country: "SG" });

const IANA = /^(?:UTC|[A-Za-z][A-Za-z_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*)+)$/;

function knownCurrencies(): ReadonlySet<string> | null {
	const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
	try {
		return intl.supportedValuesOf ? new Set(intl.supportedValuesOf("currency")) : null;
	} catch {
		return null;
	}
}

function knownRegion(code: string): boolean {
	try {
		const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
		return !!name && name !== code && !/^unknown/i.test(name);
	} catch {
		return true;
	}
}

/// Every reason this choice cannot be the home. Empty = fine.
export function homeProblems(currency: string | undefined, timeZone: string | undefined, country: string | undefined): string[] {
	const out: string[] = [];
	const code = (currency ?? "").trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(code)) out.push(`LEDGER_HOME_CURRENCY must be a 3-letter ISO 4217 code such as SGD, EUR, USD or JPY (got "${currency ?? ""}")`);
	else if (knownCurrencies() && !knownCurrencies()!.has(code)) out.push(`LEDGER_HOME_CURRENCY "${code}" is not a currency code (ISO 4217)`);
	else if (exponent(code) > 2) out.push(`LEDGER_HOME_CURRENCY ${code} has 3 decimals, which the ledger does not keep as a home currency yet (purchases in it are fine)`);
	const tz = (timeZone ?? "").trim();
	let zoneOk = IANA.test(tz);
	if (zoneOk) {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: tz });
		} catch {
			zoneOk = false;
		}
	}
	if (!zoneOk) out.push(`LEDGER_TIMEZONE must be an IANA time zone such as Asia/Singapore, Europe/London or America/New_York (got "${timeZone ?? ""}")`);
	const cc = (country ?? "").trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(cc) || !knownRegion(cc)) out.push(`LEDGER_HOME_COUNTRY must be a 2-letter ISO 3166 country code such as SG, GB, DE, US or JP (got "${country ?? ""}")`);
	return out;
}

export function makeHome(currency: string | undefined, timeZone: string | undefined, country: string | undefined): Home {
	const problems = homeProblems(currency, timeZone, country);
	if (problems.length) throw new RangeError(problems.join("; "));
	return Object.freeze({ currency: currency!.trim().toUpperCase(), timeZone: timeZone!.trim(), country: country!.trim().toUpperCase() });
}

export interface HomeVars {
	LEDGER_HOME_CURRENCY?: string;
	LEDGER_TIMEZONE?: string;
	LEDGER_HOME_COUNTRY?: string;
}

/// The worker's vars → the home, or the reasons it is not set up.
export function homeFromVars(vars: HomeVars): Home | string {
	const problems = homeProblems(vars.LEDGER_HOME_CURRENCY, vars.LEDGER_TIMEZONE, vars.LEDGER_HOME_COUNTRY);
	return problems.length ? problems.join("; ") : makeHome(vars.LEDGER_HOME_CURRENCY, vars.LEDGER_TIMEZONE, vars.LEDGER_HOME_COUNTRY);
}

let current: Home | null = null;

export function setHome(h: Home): void {
	current = h;
}

/// The configured home. Never a silent default: a worker that was not given its
/// home refuses at its entry (worker/src/setup-check), so reaching this unset is a bug.
export function home(): Home {
	if (!current) throw new Error("the ledger's home (LEDGER_HOME_CURRENCY, LEDGER_TIMEZONE) was not set");
	return current;
}

export function homeCurrency(): string {
	return home().currency;
}

export function homeCountry(): string {
	return home().country;
}

/// An amount in the home currency, ready to show.
export function homeMoney(minor: number): Money {
	return money(minor, homeCurrency());
}

// ---------------------------------------------------------------- the calendar

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
		formatters.set(tz, f);
	}
	return f;
}

interface Wall {
	y: number;
	m: number;
	d: number;
	h: number;
	mi: number;
	s: number;
	wd: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function wall(instant: Date, tz = home().timeZone): Wall {
	if (Number.isNaN(instant.getTime())) throw new RangeError("not an instant");
	const p: Record<string, string> = {};
	for (const part of formatter(tz).formatToParts(instant)) p[part.type] = part.value;
	return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second), wd: WEEKDAYS.indexOf(p.weekday!) };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/// The owner's calendar date of an instant.
export function localDate(instant: Date): string {
	const w = wall(instant);
	return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
}

/// The owner's wall clock, HH:MM.
export function localTime(instant: Date): string {
	const w = wall(instant);
	return `${pad(w.h)}:${pad(w.mi)}`;
}

export function localHour(instant: Date): number {
	return wall(instant).h;
}

/// 0 = Sunday … 6 = Saturday, on the owner's calendar.
export function localWeekday(instant: Date): number {
	return wall(instant).wd;
}

/// How far the zone's clock is ahead of UTC at `ms`, in ms.
function offsetAt(ms: number, tz: string): number {
	const w = wall(new Date(ms), tz);
	return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/// The first instant of the owner's calendar day `date` (YYYY-MM-DD): local
/// midnight, or — in a zone that skipped its midnight that day — the first
/// minute the clock showed. A month's or a day's window is [dayStart(a), dayStart(b)).
export function dayStart(date: string): Date {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`not a date: ${date}`);
	const tz = home().timeZone;
	const midnightUtc = Date.parse(`${date}T00:00:00Z`);
	let t = midnightUtc - offsetAt(midnightUtc, tz);
	t = midnightUtc - offsetAt(t, tz);
	// Midnight skipped (the clock jumped from 23:59 to 01:00): t lands on the
	// day before. Move forward by the jump.
	const d = (ms: number) => {
		const w = wall(new Date(ms), tz);
		return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
	};
	if (d(t) < date) t += offsetAt(t + 3 * 3_600_000, tz) - offsetAt(t, tz);
	// And never later than the day's first instant.
	while (d(t - 60_000) === date) t -= 60_000;
	return new Date(t);
}

/// "21:30 on 2026-10-01 (America/New_York time)" — for alarm wording.
export function localClockText(iso: string): string {
	const instant = new Date(iso);
	return `${localTime(instant)} on ${localDate(instant)} (${home().timeZone} time)`;
}
