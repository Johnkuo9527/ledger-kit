/// Reading what a person (or Claude on his behalf) typed. Every refusal is a
/// Refused with a sentence the owner could act on — the page shows it as is, and
/// Claude reads it back to him.

import { homeCurrency } from "../../src/home";
import { isIsoDate } from "../../src/dates";
import { isCurrency, parseMajor } from "../../src/money";
import { Refused } from "../../src/refused";

export function isoDate(v: unknown, field: string): string {
	if (!isIsoDate(v)) throw new Refused(`${field} must be a date written like 2026-03-05`);
	return v;
}

export function optIsoDate(v: unknown, field: string): string | null {
	return v === undefined || v === null || v === "" ? null : isoDate(v, field);
}

export function text(v: unknown, field: string, max: number): string {
	if (typeof v !== "string" || !v.trim()) throw new Refused(`${field} is missing`);
	const t = v.trim();
	if (t.length > max) throw new Refused(`${field} is longer than ${max} characters`);
	return t;
}

export function optText(v: unknown, field: string, max: number): string | null {
	return v === undefined || v === null || (typeof v === "string" && !v.trim()) ? null : text(v, field, max);
}

/// A currency the owner typed; none = the home currency (src/home.ts).
export function currency(v: unknown, fallback = homeCurrency()): string {
	if (v === undefined || v === null || v === "") return fallback;
	const c = typeof v === "string" ? v.trim().toUpperCase() : "";
	if (!isCurrency(c)) throw new Refused(`currency must be a three-letter code such as ${homeCurrency()}, USD or EUR`);
	return c;
}

/// "12.50", "1,234", "-3" (or a JSON number, read as its decimal text) → integer
/// minor units, never through a float. Too many decimals is refused, not rounded.
export function amount(v: unknown, cur: string, field: string): number {
	if (typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) throw new Refused(`${field} is missing`);
	const raw = String(v).trim();
	try {
		return parseMajor(raw, cur);
	} catch {
		throw new Refused(`${field} "${raw}" is not an amount in ${cur} like 12.50`);
	}
}

export function optBool(v: unknown, field: string): boolean | null {
	if (v === undefined || v === null || v === "") return null;
	if (v === true || v === "true" || v === "1") return true;
	if (v === false || v === "false" || v === "0") return false;
	throw new Refused(`${field} must be true or false`);
}

export function idList(v: unknown, field: string, max = 500): string[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw new Refused(`${field} must be a list of line ids`);
	if (v.length > max) throw new Refused(`${field} lists more than ${max} lines`);
	return v as string[];
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
	if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new Refused(`${field} must be one of: ${allowed.join(", ")}`);
	return v as T;
}

export function optOneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T | null {
	return v === undefined || v === null || v === "" ? null : oneOf(v, allowed, field);
}

export function optInt(v: unknown, field: string, min: number, max: number): number | null {
	if (v === undefined || v === null || v === "") return null;
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isInteger(n) || n < min || n > max) throw new Refused(`${field} must be a whole number from ${min} to ${max}`);
	return n;
}
