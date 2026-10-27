/// Money as integers. Every amount in the ledger is a whole number of the
/// currency's smallest unit ("minor units"): cents for SGD and TWD, whole yen for
/// JPY. Floats appear only inside a conversion, and every conversion ends in
/// ONE rounding (half away from zero) back to an integer.

/// ISO 4217 exponents that are not 2. Anything not listed has 2 decimals.
/// TWD is ISO-2 even though NT$ is usually printed whole; storing ×100 costs
/// nothing and keeps foreign-currency 台新 lines with decimals exact.
const EXPONENTS: Readonly<Record<string, number>> = {
	JPY: 0,
	KRW: 0,
	VND: 0,
	CLP: 0,
	ISK: 0,
	PYG: 0,
	UGX: 0,
	XAF: 0,
	XOF: 0,
	BHD: 3,
	JOD: 3,
	KWD: 3,
	OMR: 3,
	TND: 3,
};

export function exponent(currency: string): number {
	return EXPONENTS[currency.toUpperCase()] ?? 2;
}

export function isCurrency(value: unknown): value is string {
	return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/// Half away from zero. The epsilon absorbs binary noise such as
/// 1.005 * 100 = 100.49999999999999, which must round to 101.
export function roundHalfAway(x: number): number {
	if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x}`);
	const sign = x < 0 ? -1 : 1;
	return sign * Math.floor(Math.abs(x) + 0.5 + 1e-9) || 0;
}

/// Convert an integer amount between currencies at `rate` (units of `to` per one
/// unit of `from`). Returns an integer in `to`'s minor units.
export function convertMinor(minor: number, from: string, to: string, rate: number): number {
	assertMinor(minor);
	if (!(rate > 0)) throw new RangeError(`rate must be positive, got ${rate}`);
	const major = minor / 10 ** exponent(from);
	return roundHalfAway(major * rate * 10 ** exponent(to));
}

/// Major-unit value of an integer amount — for ratios only, never for storage.
export function toMajor(minor: number, currency: string): number {
	return minor / 10 ** exponent(currency);
}

/// Parse a typed amount ("12.50", "1,234", "-3") WITHOUT going through a float,
/// so "0.1" + "0.2" style errors cannot enter. Rejects more decimals than the
/// currency has (a yen amount with cents is a mistake, not something to round).
export function parseMajor(text: string, currency: string): number {
	const cleaned = text.trim().replace(/,/g, "");
	const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(cleaned);
	if (!m) throw new RangeError(`not an amount: "${text}"`);
	const exp = exponent(currency);
	const frac = m[3] ?? "";
	if (frac.length > exp) throw new RangeError(`"${text}" has more decimals than ${currency} allows`);
	const minor = Number(m[2] + frac.padEnd(exp, "0"));
	if (!Number.isSafeInteger(minor)) throw new RangeError(`amount too large: "${text}"`);
	return m[1] ? -minor : minor;
}

/// A figure as a phone, an SMS or a bank PRINTS it, in any locale — "12,50",
/// "1.234,56", "1 234,56" (any space, including the no-break ones iOS uses),
/// "1'234.50", "1,23,456.00", "1,200" — to integer minor units, never through
/// a float. The last of "." and "," is the decimal point when both appear; a
/// lone separator followed by exactly three digits groups thousands (in a
/// currency with 3 decimals it is the decimal point). A zero-decimal currency
/// printed with ".00" is read whole. No currency symbol or code: the caller
/// strips those. Anything else — groups that are not 3 digits, two decimal
/// points, more decimals than the currency has — is refused, never guessed.
export function parsePrinted(text: string, currency: string): number {
	let t = text.normalize("NFKC").trim().replace(/[\u2212\u2012\u2013\u2014]/g, "-");
	let negative = false;
	if (t.startsWith("-")) {
		negative = true;
		t = t.slice(1);
	} else if (t.endsWith("-")) {
		negative = true;
		t = t.slice(0, -1);
	}
	t = t.replace(/[\s\u00A0\u202F\u2009'’]/g, "");
	if (!/^\d[\d.,]*$/.test(t) || /[.,]$/.test(t)) throw new RangeError(`not an amount: "${text}"`);
	const exp = exponent(currency);
	const groupsOk = (parts: readonly string[]) => parts.slice(1).every((p) => p.length === 3 || p.length === 2) && parts.slice(1).at(-1)!.length === 3;
	let whole: string;
	let frac = "";
	const dot = t.lastIndexOf(".");
	const comma = t.lastIndexOf(",");
	if (dot >= 0 && comma >= 0) {
		const dec = dot > comma ? "." : ",";
		const grp = dec === "." ? "," : ".";
		const at = t.lastIndexOf(dec);
		const head = t.slice(0, at);
		frac = t.slice(at + 1);
		if (head.includes(dec) || frac.includes(grp)) throw new RangeError(`not an amount: "${text}"`);
		const parts = head.split(grp);
		if (!groupsOk(parts)) throw new RangeError(`not an amount: "${text}"`);
		whole = parts.join("");
	} else if (dot >= 0 || comma >= 0) {
		const parts = t.split(dot >= 0 ? "." : ",");
		if (parts.length > 2) {
			if (!parts.slice(1).every((p) => p.length === 3)) throw new RangeError(`not an amount: "${text}"`);
			whole = parts.join("");
		} else if (parts[1]!.length === 3 && exp !== 3) {
			whole = parts.join("");
		} else {
			whole = parts[0]!;
			frac = parts[1]!;
		}
	} else {
		whole = t;
	}
	if (exp === 0 && /^0+$/.test(frac)) frac = "";
	if (frac.length > exp) throw new RangeError(`"${text}" has more decimals than ${currency} allows`);
	const minor = Number(whole + frac.padEnd(exp, "0"));
	if (!Number.isSafeInteger(minor)) throw new RangeError(`amount too large: "${text}"`);
	return negative ? -minor : minor;
}

/// "SGD 1,234.50" / "JPY 1,200" / "−SGD 3.00". Plain and unambiguous; the page
/// is free to style it, the connector reads it as is.
export function formatMoney(minor: number, currency: string): string {
	assertMinor(minor);
	const exp = exponent(currency);
	const abs = Math.abs(minor);
	const whole = Math.floor(abs / 10 ** exp);
	const frac = exp > 0 ? "." + String(abs % 10 ** exp).padStart(exp, "0") : "";
	const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${minor < 0 ? "−" : ""}${currency} ${grouped}${frac}`;
}

/// How an amount reads to the owner, in his language and locale ("€12.50", "$4.50"),
/// is src/words.ts sayMoney; `display` below is the plain ISO form the connector reads.

export interface Money {
	currency: string;
	minor: number;
	display: string;
}

export function money(minor: number, currency: string): Money {
	return { currency, minor, display: formatMoney(minor, currency) };
}

export function assertMinor(minor: number): void {
	if (!Number.isSafeInteger(minor)) throw new TypeError(`money must be an integer of minor units, got ${minor}`);
}
