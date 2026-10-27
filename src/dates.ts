/// Calendar dates are 'YYYY-MM-DD' strings on the owner's calendar (which day an
/// instant falls on is src/home.ts's job, the one place that knows the zone).
/// Arithmetic here is done on UTC midnights, so no daylight saving or host
/// time zone can shift a day.

const DAY_MS = 86_400_000;

export function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(value + "T00:00:00Z");
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toUtc(date: string): number {
	if (!isIsoDate(date)) throw new RangeError(`not a date: ${date}`);
	return Date.parse(date + "T00:00:00Z");
}

function fromUtc(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/// b − a in whole days.
export function daysBetween(a: string, b: string): number {
	return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
	return fromUtc(toUtc(date) + days * DAY_MS);
}

/// Same day-of-month `months` later, clamped to the month's end
/// (31 Jan + 1 month = 28/29 Feb), anchored on `anchorDay` when given so a
/// subscription billed on the 31st returns to the 31st after a short month.
export function addMonths(date: string, months: number, anchorDay?: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const total = y * 12 + (m - 1) + months;
	const ny = Math.floor(total / 12);
	const nm = (total % 12) + 1;
	const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
	const day = Math.min(anchorDay ?? d, last);
	return `${ny}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function minDate(a: string, b: string): string {
	return a <= b ? a : b;
}

export function maxDate(a: string, b: string): string {
	return a >= b ? a : b;
}
