/// Merchant names, normalised so the same shop matches itself across a bank
/// alert ("GRAB*A-7F3K2 SINGAPORE SG"), a receipt ("Grab") and a statement line
/// ("GRAB* A-7F3K2"). The playbook adds aliases on top of the built-in ones;
/// nothing here is the owner-specific.

export interface MerchantAlias {
	/// Matched against the upper-cased raw text (after processor prefixes are
	/// stripped). A plain string matches as a prefix; "/…/" is a regex.
	pattern: string;
	canonical: string;
}

/// Payment processors that prefix the real merchant's name.
const PROCESSOR_PREFIXES = [
	/^SQ ?\*\s*/,
	/^PAYPAL ?\*\s*/,
	/^PP ?\*\s*/,
	/^SP ?\*\s*/,
	/^TST ?\*\s*/,
	/^IZ ?\*\s*/,
	/^SUMUP ?\*\s*/,
	/^ZETTLE_?\*\s*/,
	/^STRIPE ?\*\s*/,
	/^GOOGLE ?\*\s*/,
	/^GPAY ?\*\s*/,
	/^APPLE PAY ?\*?\s*/,
];

export const BUILTIN_ALIASES: readonly MerchantAlias[] = [
	{ pattern: "APPLE.COM/BILL", canonical: "APPLE" },
	{ pattern: "APPLE.COM", canonical: "APPLE" },
	{ pattern: "ITUNES", canonical: "APPLE" },
	{ pattern: "AMZN", canonical: "AMAZON" },
	{ pattern: "AMAZON", canonical: "AMAZON" },
	{ pattern: "NETFLIX", canonical: "NETFLIX" },
	{ pattern: "SPOTIFY", canonical: "SPOTIFY" },
	{ pattern: "/^GRAB(?![A-Z]*FOOD)/", canonical: "GRAB" },
	{ pattern: "GRABFOOD", canonical: "GRAB FOOD" },
	{ pattern: "ANTHROPIC", canonical: "ANTHROPIC" },
	{ pattern: "CLAUDE.AI", canonical: "ANTHROPIC" },
];

/// Words that say nothing about which merchant it is.
const FILLER = new Set([
	"PTE",
	"LTD",
	"LIMITED",
	"INC",
	"LLC",
	"CORP",
	"CO",
	"COMPANY",
	"THE",
	"SINGAPORE",
	"SGP",
	"SG",
	"COM",
	"WWW",
	"HTTPS",
	"HTTP",
	"BILL",
	"PAYMENT",
	"ONLINE",
]);

/// Two-letter country codes a descriptor often ends with ("… TOKYO JP").
const TRAILING_COUNTRY = /\s+(SG|JP|TW|US|GB|HK|MY|TH|ID|KR|AU|FR|DE|IT|ES|NL|CH|CN|VN|PH|IN|AE|IE|LU|CA|NZ)$/;

/// A booking or terminal reference mixed into a descriptor: letters and digits
/// together, at least two digits, five or more characters.
function isReferenceCode(token: string): boolean {
	const digits = token.replace(/\D/g, "").length;
	return token.length >= 5 && digits >= 2 && digits < token.length;
}

function aliasMatches(alias: MerchantAlias, text: string): boolean {
	if (alias.pattern.length > 2 && alias.pattern.startsWith("/") && alias.pattern.endsWith("/")) {
		return new RegExp(alias.pattern.slice(1, -1)).test(text);
	}
	return text.startsWith(alias.pattern.toUpperCase());
}

/// The matching key. Same merchant → same key, as far as rules can tell.
/// Playbook aliases are tried before the built-in ones, so the senior model can
/// correct a built-in.
export function merchantKey(raw: string | null | undefined, aliases: readonly MerchantAlias[] = []): string {
	if (!raw) return "";
	let text = raw.normalize("NFKC").toUpperCase().trim().replace(/\s+/g, " ");
	for (const prefix of PROCESSOR_PREFIXES) text = text.replace(prefix, "");
	for (const alias of [...aliases, ...BUILTIN_ALIASES]) {
		if (aliasMatches(alias, text)) return alias.canonical.toUpperCase();
	}
	text = text.replace(TRAILING_COUNTRY, "");
	// Keep letters (any script — 台新 merchants are Chinese) and digits; the rest
	// becomes a space. Then drop store numbers and filler words.
	const tokens = text
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.split(" ")
		.filter((t) => t.length > 0)
		.filter((t) => !/^\d{3,}$/.test(t)) // store numbers; keeps the 7 of 7-ELEVEN
		.filter((t) => !isReferenceCode(t)) // "A7F3K2"-style booking refs, not "7ELEVEN"
		.filter((t) => !FILLER.has(t));
	return tokens.join(" ");
}

/// 0..1. 1 = same key; 0.8 = one contains the other (SHOPEE vs SHOPEE MP,
/// GRABFOOD vs GRAB FOOD); otherwise the share of words in common.
export function merchantSimilarity(a: string, b: string): number {
	if (!a || !b) return 0;
	if (a === b) return 1;
	const ca = a.replace(/ /g, "");
	const cb = b.replace(/ /g, "");
	if (ca === cb) return 0.95;
	const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
	if (short.length >= 4 && long.startsWith(short)) return 0.8;
	const ta = new Set(a.split(" "));
	const tb = new Set(b.split(" "));
	let common = 0;
	for (const t of ta) if (tb.has(t)) common++;
	const smaller = ta.size <= tb.size ? ta : tb;
	// Every word of the shorter name appears in the longer one ("SHOPEE" in
	// "SHOPEE MP"), and the shorter name is not a scrap like "A" or "MY".
	if (common === smaller.size && [...smaller].join("").length >= 4) return 0.8;
	return common / (ta.size + tb.size - common);
}

/// Display name: the key in title case, unless the source gave a nicer one.
export function merchantDisplay(key: string): string {
	return key
		.split(" ")
		.map((w) => (/^[A-Z]+$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w))
		.join(" ");
}
