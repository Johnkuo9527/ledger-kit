/// The Apple Pay shortcut (the owner). An iPhone Shortcuts "Transaction"
/// automation runs on every Apple Pay tap and POSTs what Wallet knows to the
/// ledger. It is evidence exactly like a bank alert — it matches into the same
/// one-line-per-purchase — and it covers every card he taps, including the
/// 台新 cards that send no email. A line it creates is provisional until a
/// statement confirms it.
///
/// The endpoint itself is built in the worker; this file is its contract:
///
///   POST /api/shortcut/tap
///   Authorization: Bearer <LEDGER_SHORTCUT_KEY>      (a worker secret)
///   Content-Type: application/json
///   { "card": "HSBC Visa Example", "merchant": "Kopi Corner",
///     "amount": "S$4.50", "currency": "SGD",          (currency optional)
///     "timestamp": "2026-03-05T08:15:00+08:00" }
///
///   200 {ok:true, status:"created"|"attached"|"duplicate"|"held", line_id|null}
///   400 {ok:false, message}   — payload unusable (says which field)
///   401 {ok:false, message:"not authorised"} — wrong or missing key
///
/// The key is its OWN secret, not the page's unlock key: it lives inside a
/// shortcut on the phone, so it must be revocable without locking the owner out of
/// the page. It is compared in constant time.

import { localDate, localTime } from "./home";
import { merchantKey } from "./merchant";
import { isCurrency, parsePrinted } from "./money";
import { homeCurrency } from "./home";

export interface ShortcutTap {
	card: string;
	merchant: string;
	amount: string;
	currency?: string;
	timestamp: string;
}

export interface ParsedTap {
	wallet_key: string;
	currency: string;
	amount_minor: number; // + money out (a tap is always a payment)
	merchant_raw: string;
	txn_date: string; // the owner's calendar date (src/home.ts)
	txn_time: string; // the owner's clock, HH:MM
	fingerprint: string;
}

/// Wallet card names are matched loosely: case, spacing and punctuation never
/// matter ("HSBC  Visa  Example" = "hsbc visa example").
export function walletKey(name: string): string {
	return name
		.normalize("NFKC")
		.toUpperCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/// Currency marks Wallet prints before or after an amount, in any locale. A
/// mark that names one currency only ("S$", "€", "NT$") says which; the
/// ambiguous ones ("$", "¥", "kr") mean the owner's home currency when it is
/// one they can mean, else they need the currency field.
const SYMBOLS: readonly [string, string][] = [
	["S$", "SGD"], ["NT$", "TWD"], ["US$", "USD"], ["HK$", "HKD"], ["A$", "AUD"], ["AU$", "AUD"], ["NZ$", "NZD"], ["C$", "CAD"], ["CA$", "CAD"], ["R$", "BRL"], ["MX$", "MXN"],
	["RM", "MYR"], ["€", "EUR"], ["£", "GBP"], ["₩", "KRW"], ["฿", "THB"], ["₹", "INR"], ["₱", "PHP"], ["₫", "VND"], ["₪", "ILS"], ["₺", "TRY"], ["zł", "PLN"], ["Kč", "CZK"], ["Rp", "IDR"], ["円", "JPY"], ["JP¥", "JPY"], ["CN¥", "CNY"], ["元", "CNY"],
];
const AMBIGUOUS: readonly [string, readonly string[], string | null][] = [
	// mark, the currencies it may mean, what it means when the home is none of them
	["$", ["USD", "SGD", "AUD", "CAD", "NZD", "HKD", "TWD", "MXN", "BND", "ARS", "CLP", "COP"], null],
	["¥", ["JPY", "CNY"], "JPY"],
	["kr", ["SEK", "NOK", "DKK", "ISK"], null],
];

/// The currency a printed mark ("S$", "€", "$", "EUR") stands for at this home;
/// null = it could be several, or it is not a mark.
export function currencyOfMark(mark: string): string | null {
	const m = mark.normalize("NFKC").trim();
	if (/^[A-Za-z]{3}$/.test(m) && isCurrency(m.toUpperCase())) return m.toUpperCase();
	const sure = SYMBOLS.find(([s]) => s === m)?.[1];
	if (sure) return sure;
	const vague = AMBIGUOUS.find(([s]) => s === m);
	if (!vague) return null;
	return vague[1].includes(homeCurrency()) ? homeCurrency() : vague[2];
}

/// Strip one currency mark from the start or the end of `text`; null = none there.
function stripMark(text: string): { mark: string; rest: string } | null {
	const marks = [...SYMBOLS.map(([m]) => m), ...AMBIGUOUS.map(([m]) => m)].sort((a, b) => b.length - a.length);
	for (const m of marks) {
		if (text.startsWith(m)) return { mark: m, rest: text.slice(m.length).trim() };
		if (text.endsWith(m)) return { mark: m, rest: text.slice(0, -m.length).trim() };
	}
	// An ISO code before or after the figure ("USD 12.00", "12.00 USD", "CHF 1'234.50").
	const lead = /^([A-Z]{3})\s*(.*)$/.exec(text);
	if (lead) return { mark: lead[1]!, rest: lead[2]!.trim() };
	const trail = /^(.*?)\s*([A-Z]{3})$/.exec(text);
	if (trail) return { mark: trail[2]!, rest: trail[1]!.trim() };
	return null;
}

/// "S$4.50", "12,50 €", "1.234,56 €", "$4.50" (a US iPhone), "¥1,200", "CHF
/// 1'234.50", "99,00 kr" → currency and integer amount (src/money.ts
/// parsePrinted reads the figure). No mark at all: the currency field, else the
/// home currency. A mark that says one currency and a field that says another
/// is refused, never guessed.
export function parseTapAmount(amount: string, currency: string | undefined): { currency: string; minor: number } | string {
	let text = amount.normalize("NFKC").trim();
	let negative = false;
	const sign = /^[-\u2212]\s*/.exec(text);
	if (sign) {
		negative = true;
		text = text.slice(sign[0].length);
	}
	const field = currency?.trim().toUpperCase() || null;
	if (field !== null && !isCurrency(field)) return "the currency is unknown: send the currency field as a 3-letter code";
	const home = homeCurrency();
	let code: string | null = field ?? null;
	const found = stripMark(text);
	if (found) {
		text = found.rest;
		if (/^[-\u2212]/.test(text)) {
			negative = true;
			text = text.replace(/^[-\u2212]\s*/, "");
		}
		const sure = SYMBOLS.find(([m]) => m === found.mark)?.[1] ?? (/^[A-Z]{3}$/.test(found.mark) ? found.mark : null);
		const vague = AMBIGUOUS.find(([m]) => m === found.mark);
		if (sure) {
			if (field && field !== sure) return `the amount says ${sure} but currency says ${field}`;
			code = sure;
		} else if (vague && !field) {
			code = vague[1].includes(home) ? home : vague[2];
			if (!code) return `"${found.mark}" could be several currencies: send the currency field`;
		}
	}
	code ??= home;
	if (!isCurrency(code)) return "the currency is unknown: send the currency field";
	if (negative) return "the amount must be more than zero";
	try {
		const minor = parsePrinted(text, code);
		if (minor <= 0) return "the amount must be more than zero";
		return { currency: code, minor };
	} catch {
		return `cannot read the amount "${amount}"`;
	}
}

/// Validate and normalise one tap. A string is the reason it was refused.
export function parseTap(body: unknown): ParsedTap | string {
	if (typeof body !== "object" || body === null) return "the body must be a JSON object";
	const t = body as Partial<ShortcutTap>;
	if (typeof t.card !== "string" || !t.card.trim()) return "card is missing";
	if (typeof t.merchant !== "string" || !t.merchant.trim()) return "merchant is missing";
	if (typeof t.amount !== "string" && typeof t.amount !== "number") return "amount is missing";
	if (typeof t.timestamp !== "string") return "timestamp is missing";
	const instant = new Date(t.timestamp);
	if (Number.isNaN(instant.getTime()) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(t.timestamp)) {
		return "timestamp must be ISO 8601 with a time zone";
	}
	const amount = parseTapAmount(String(t.amount), t.currency);
	if (typeof amount === "string") return amount;
	const txnDate = localDate(instant);
	const txnTime = localTime(instant);
	const wallet = walletKey(t.card);
	return {
		wallet_key: wallet,
		currency: amount.currency,
		amount_minor: amount.minor,
		merchant_raw: t.merchant.trim(),
		txn_date: txnDate,
		txn_time: txnTime,
		// Same card, amount, merchant and minute: the shortcut ran twice.
		fingerprint: ["tap", wallet, amount.currency, amount.minor, txnDate, txnTime, merchantKey(t.merchant)].join("|"),
	};
}

/// The account a Wallet card name belongs to; null = unknown (the tap is held
/// and escalated, never guessed onto a card).
export function accountForWallet(walletKeyValue: string, names: ReadonlyMap<string, string>): string | null {
	return names.get(walletKeyValue) ?? null;
}

async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/// True only for "Bearer <exactly the secret>". Constant time: both sides are
/// hashed first, so neither the length nor a matching prefix leaks.
export async function shortcutAuthorised(authorization: string | null, secret: string | undefined): Promise<boolean> {
	if (!secret || secret.length < 32 || !authorization) return false;
	const m = /^Bearer (.+)$/.exec(authorization.trim());
	if (!m) return false;
	const [a, b] = await Promise.all([sha256(m[1]!), sha256(secret)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}
