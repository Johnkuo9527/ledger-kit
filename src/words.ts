/// The owner's LANGUAGE, and every word the ledger says to him (CONTRACT §19).
///
/// Chosen once, at install (wrangler.toml [vars] LEDGER_LANGUAGE, written by
/// scripts/setup.sh): "en" (the kit's default) or "zh-Hant" (Traditional
/// Chinese). The worker sets it at each entry with the home (env.ts useHome);
/// the tests with setLanguage (they start in "zh-Hant", the wording the kit was
/// first written in, test/helpers/home-default.ts).
///
/// Its interface is small on purpose:
///   say(key, vars)       a sentence from the catalogue, blanks filled, the count's form picked
///   sayMoney(minor, cur) an amount the way the owner's locale writes it ("€12.50", "$4.50", "¥1,200")
///   sayDate / sayDayMonth / sayMonth   a day or month the same way ("12 Oct 2026", "2026年10月12日")
///   currencyName(code)   "Euro", "新加坡幣"
/// The catalogues (words/en.ts, words/zh-Hant.ts) hold every sentence; the
/// "page." part of them is the page's (page/words.js, served per language by
/// worker/src/page.ts). A key exists in both or the type-check fails.
///
/// What is never translated: the owner's data — merchant names, statement
/// lines, account and category names he typed, a shop's SMS. It is shown as it is.

import { exponent } from "./money";
import { home } from "./home";
import { EN, type Entry, type Key } from "./words/en";
import { ZH_HANT } from "./words/zh-Hant";

export type { Key } from "./words/en";
export type Language = "en" | "zh-Hant";
export const LANGUAGES: readonly Language[] = ["en", "zh-Hant"];
export const DEFAULT_LANGUAGE: Language = "en";

const CATALOGUES: Readonly<Record<Language, Readonly<Record<Key, Entry>>>> = { en: EN, "zh-Hant": ZH_HANT };

/// Why this LEDGER_LANGUAGE cannot be used, or null. Unset means English.
export function languageProblem(raw: string | undefined): string | null {
	const v = (raw ?? "").trim();
	if (!v || (LANGUAGES as readonly string[]).includes(v)) return null;
	return `LEDGER_LANGUAGE must be "en" (English) or "zh-Hant" (Traditional Chinese) (got "${v}")`;
}

export function languageFrom(raw: string | undefined): Language {
	const problem = languageProblem(raw);
	if (problem) throw new RangeError(problem);
	return ((raw ?? "").trim() || DEFAULT_LANGUAGE) as Language;
}

let current: Language = DEFAULT_LANGUAGE;

export function setLanguage(l: Language): void {
	current = l;
}

export function language(): Language {
	return current;
}

/// The whole catalogue of a language (the tests compare the two).
export function catalogue(l: Language): Readonly<Record<Key, Entry>> {
	return CATALOGUES[l];
}

export type Vars = Readonly<Record<string, string | number>>;

const plurals = new Map<string, Intl.PluralRules>();

/// Fill one entry: {name} blanks from vars; an entry with forms picks by vars.n.
/// The page does exactly this with the same entries (page/app.js `t`).
export function fill(entry: Entry, vars: Vars | undefined, lang: Language): string {
	let text: string;
	if (typeof entry === "string") text = entry;
	else {
		let rules = plurals.get(lang);
		if (!rules) plurals.set(lang, (rules = new Intl.PluralRules(lang)));
		const form = rules.select(Number(vars?.n ?? 0)) as keyof typeof entry;
		text = entry[form] ?? entry.other;
	}
	return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export function say(key: Key, vars?: Vars): string {
	return fill(CATALOGUES[current][key], vars, current);
}

/// A name (a bank's, a card's) as it sits inside a sentence: Chinese sets a
/// Latin name apart with a space on each side (「寄來的 HSBC card 5507 帳單」, none
/// around 台新); English sentences carry their own spaces.
export function inline(name: string): string {
	if (current !== "zh-Hant") return name;
	return `${/^[A-Za-z0-9]/.test(name) ? " " : ""}${name}${/[A-Za-z0-9]$/.test(name) ? " " : ""}`;
}

/// Items one after another the way the language lists them ("a, b" / 「a、b」).
export function sayList(items: readonly string[]): string {
	return items.join(say("list.sep"));
}

/// The page's words: `window.LEDGER_WORDS = { <language>: { <key without "page."> : entry } }`.
/// page/words.js holds both (the demo opened from disk); the worker serves the owner's one.
export function pageWordsScript(langs: readonly Language[] = LANGUAGES): string {
	const out: Record<string, Record<string, Entry>> = {};
	for (const l of langs) {
		const words: Record<string, Entry> = {};
		for (const [k, v] of Object.entries(CATALOGUES[l])) if (k.startsWith("page.")) words[k.slice(5)] = v;
		out[l] = words;
	}
	return `// GENERATED from src/words/*.ts by \`npm run words\` — the page's words, one catalogue per language.\nwindow.LEDGER_WORDS = ${JSON.stringify(out, null, "\t")};\n`;
}

// ---------------------------------------------------------------- the owner's locale

/// The language with the home's country: "en-SG", "en-DE", "zh-Hant-SG". It
/// decides how money and days are written; the words come from the catalogue.
export function locale(): string {
	const tag = `${current}-${home().country}`;
	try {
		return Intl.getCanonicalLocales(tag)[0] ?? current;
	} catch {
		return current;
	}
}

const numberFormats = new Map<string, Intl.NumberFormat>();
type Display = "symbol" | "narrowSymbol" | "code";
function currencyFormat(loc: string, currency: string, display: Display): Intl.NumberFormat {
	const key = `${loc}|${currency}|${display}`;
	let f = numberFormats.get(key);
	if (!f) {
		const digits = exponent(currency);
		f = new Intl.NumberFormat(loc, { style: "currency", currency, currencyDisplay: display, minimumFractionDigits: digits, maximumFractionDigits: digits });
		numberFormats.set(key, f);
	}
	return f;
}

/// An exact decimal string of minor units ("1250", EUR → "12.50"): Intl formats
/// it without a float ever standing in for money.
function decimal(minor: number, currency: string): string {
	const e = exponent(currency);
	const abs = String(Math.abs(minor)).padStart(e + 1, "0");
	return e ? `${abs.slice(0, -e)}.${abs.slice(-e)}` : abs;
}

function mark(loc: string, currency: string, display: Display): string {
	return currencyFormat(loc, currency, display).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
}

/// The currency mark the owner reads for `currency`. His own currency: the
/// locale's symbol, or its narrow one when the locale would spell the code out
/// (he knows his own money). Another currency: the locale's symbol, unless it
/// would look exactly like his own — then the English one, else the code.
function markFor(loc: string, currency: string): { display: Display; text: string } {
	const own = home().currency;
	const homeMark = mark(loc, own, "symbol") === own ? mark(loc, own, "narrowSymbol") : mark(loc, own, "symbol");
	if (currency === own) return { display: homeMark === mark(loc, own, "symbol") ? "symbol" : "narrowSymbol", text: homeMark };
	const m = mark(loc, currency, "symbol");
	if (m !== homeMark) return { display: "symbol", text: m };
	const en = mark("en", currency, "symbol");
	return en !== homeMark && en !== currency ? { display: "symbol", text: en } : { display: "code", text: currency };
}

/// An amount as the owner reads it: "€12.50", "$4.50", "US$4.50", "¥1,200", "−€3.00".
export function sayMoney(minor: number, currency: string): string {
	const loc = locale();
	const code = currency.toUpperCase();
	const { display, text } = markFor(loc, code);
	const parts = currencyFormat(loc, code, display).formatToParts(decimal(minor, code) as unknown as number);
	const body = parts.map((p) => (p.type === "currency" ? text : p.value)).join("");
	return minor < 0 ? `−${body}` : body;
}

/// A currency's name in the owner's language ("Euro", "新加坡幣").
export function currencyName(code: string): string {
	try {
		return new Intl.DisplayNames([locale()], { type: "currency" }).of(code.toUpperCase()) ?? code;
	} catch {
		return code;
	}
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const loc = locale();
	const key = `${loc}|${JSON.stringify(opts)}`;
	let f = dateFormats.get(key);
	if (!f) dateFormats.set(key, (f = new Intl.DateTimeFormat(loc, { ...opts, timeZone: "UTC" })));
	return f;
}

const noon = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);
/// Chinese spells the month as a number with 月 ("long"); English abbreviates it.
const MONTH: Readonly<Record<Language, "short" | "long">> = { en: "short", "zh-Hant": "long" };

/// A calendar day (YYYY-MM-DD) with its year: "12 Oct 2026", "2026年10月12日".
export function sayDate(iso: string): string {
	return dateFormat({ year: "numeric", month: MONTH[current], day: "numeric" }).format(noon(iso));
}

/// A day without its year: "12 Oct", "10月12日".
export function sayDayMonth(iso: string): string {
	return dateFormat({ month: MONTH[current], day: "numeric" }).format(noon(iso));
}

/// A month (YYYY-MM): "October 2026", "2026年10月".
export function sayMonth(ym: string): string {
	return dateFormat({ year: "numeric", month: "long" }).format(noon(`${ym}-15`));
}
