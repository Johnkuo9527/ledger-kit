import { domainOf, within } from "../../src/bank-list";
import { exponent, parseMajor } from "../../src/money";

/// Which mail is a BANK's is the owner's data now (src/bank-list.ts: his
/// seed file's "banks", kept in sync_state['banks'], read by Tick.banks()) —
/// adding a bank is never a code edit. Mail counts as a bank's only when its
/// From domain is on his list AND Gmail itself vouches for that bank's domain
/// (BankList.authenticated, with authenticatedDomains below). Everything else is
/// at most a receipt, which can never create a ledger line or teach a card number.
///
/// Threat model: anyone can email the owner. Every email, receipt and PDF is
/// untrusted, and so is anything a model wrote after reading one.
///
/// What stays here, in code: Gmail's header reading, the wallets' own mail
/// (GrabPay, whose rule is code by design), and the built-in readers of four
/// banks' fixed alert formats — EXAMPLES, used only for an institution the owner
/// lists under that id ("dbs", "citi", "hsbc"); any other bank's alerts go to
/// the reader and its learned patterns.

export { BankList, domainOf, tooBroad } from "../../src/bank-list";

/// Stored-value wallets' own mail domains (14 Oct 2026): GrabPay.
/// Grab sends its e-receipts ("Your Grab E-Receipt") and the GrabPay Wallet
/// transaction statement from grab.com (no-reply@grab.com) and its mail
/// sub-domains. Only grab.com itself and its sub-domains count — never a
/// lookalike (grab-mail.com, grab.com.sg.example, "Grab" in a sender's name).
/// Mail Gmail vouches for here is the source of truth for the WALLET ONLY: it
/// may create and confirm lines on the GrabPay account, never on any bank or
/// card (pipeline.ts grabUnit fixes the account in code, never from the mail).
export const WALLET_DOMAINS: Readonly<Record<string, readonly string[]>> = {
	grab: ["grab.com"],
};

/// The wallet issuer whose mail this is, if Gmail vouches (DMARC/DKIM pass)
/// for a domain of that SAME issuer and the From address is one of its own.
export function walletAuthenticated(fromAddr: string, auth: readonly string[]): string | null {
	const of = (domain: string) => {
		const d = domain.trim().toLowerCase();
		for (const [issuer, domains] of Object.entries(WALLET_DOMAINS)) if (domains.some((b) => within(d, b))) return issuer;
		return null;
	};
	const issuer = of(domainOf(fromAddr));
	if (!issuer) return null;
	return auth.some((a) => of(a) === issuer) ? issuer : null;
}

/// The domains Gmail's OWN Authentication-Results header vouches for. Gmail
/// adds its header on top when mail arrives, so only the TOPMOST one counts,
/// and only if it is Gmail's (mx.google.com); any lower one was written by
/// whoever sent the mail and proves nothing. DMARC pass gives header.from;
/// DKIM pass gives header.d (or header.i's domain).
export function authenticatedDomains(headerValues: readonly string[]): string[] {
	const ours = headerValues[0];
	if (!ours || !/^\s*mx\.google\.com\s*(;|$)/i.test(ours)) return [];
	const out = new Set<string>();
	for (const clause of ours.split(";").slice(1)) {
		const c = clause.trim().toLowerCase();
		const m = /^(dmarc|dkim)\s*=\s*(\w+)/.exec(c);
		if (!m || m[2] !== "pass") continue;
		if (m[1] === "dmarc") {
			const from = /\bheader\.from\s*=\s*([a-z0-9.-]+)/.exec(c)?.[1];
			if (from) out.add(from);
		} else {
			const d = /\bheader\.d\s*=\s*([a-z0-9.-]+)/.exec(c)?.[1] ?? /\bheader\.i\s*=\s*[^@\s]*@([a-z0-9.-]+)/.exec(c)?.[1];
			if (d) out.add(d);
		}
	}
	return [...out];
}

// ------------------------------------------------------- built-in readers
//
// Fixed-format alerts four Singapore/Taiwan banks have sent for years (14 Oct
// 2026) — the kit's EXAMPLES: read by code, never by a model, so they never wait for a reader and
// never need a learned pattern. Each one is tried ONLY on mail Gmail vouched
// for as that bank's own (the alert path is reached only after
// bankAuthenticated), and each returns null unless every field it needs is
// there — anything it does not recognise goes to the reader exactly as before.

/// What a built-in reader returns: the same shape a playbook pattern does.
export interface BuiltInAlert {
	pattern_id: string;
	institution: string;
	kind_hint: "purchase" | "transfer" | "income" | "payment";
	currency: string;
	amount_minor: number; // signed: + money out
	last4: string | null;
	merchant_raw: string | null;
	merchant_country: string | null;
	txn_date: string;
	txn_time: string | null;
}

interface AlertMail {
	subject: string;
	body: string;
	/// YYYY-MM-DD (the owner's day) the email arrived: the year for dates printed without one.
	received_date: string;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/// ISO 3166 alpha-3 → alpha-2, for the countries Citi prints after a merchant.
const ISO3: Readonly<Record<string, string>> = {
	SGP: "SG", MYS: "MY", TWN: "TW", JPN: "JP", HKG: "HK", CHN: "CN", KOR: "KR", THA: "TH", IDN: "ID", VNM: "VN", PHL: "PH",
	USA: "US", GBR: "GB", IRL: "IE", NLD: "NL", FRA: "FR", DEU: "DE", AUS: "AU", LUX: "LU", CHE: "CH", HUN: "HU", ITA: "IT", ESP: "ES",
};

const iso = (y: number, m: number, d: number): string | null => {
	if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
	const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
	const dt = new Date(`${s}T00:00:00Z`);
	return dt.getUTCDate() === d ? s : null;
};

/// "13 Oct" / "13 OCT 2026" → a date, the year (when not printed) being the
/// one that puts it on or before the day the email arrived.
function dayMonth(text: string, received: string): string | null {
	const m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*(?:\s+(\d{4}))?$/.exec(text.trim());
	if (!m) return null;
	const month = MONTHS.indexOf(m[2]!.toUpperCase()) + 1;
	if (!month) return null;
	const y = m[3] ? Number(m[3]) : Number(received.slice(0, 4));
	const out = iso(y, month, Number(m[1]));
	if (!out) return null;
	return !m[3] && out > received ? iso(y - 1, month, Number(m[1])) : out;
}

/// "SGD12.60", "SGD 12.60", "S$2.10" → [currency, minor units]; null = not a plain amount.
function money(cur: string, amount: string): [string, number] | null {
	const currency = cur.toUpperCase() === "S$" ? "SGD" : cur.toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency) || !/^\d[\d,]*(?:\.\d+)?$/.test(amount.trim())) return null;
	try {
		return [currency, parseMajor(amount, currency)];
	} catch {
		// A whole-number currency printed with ".00" (JPY 1,200.00).
		const whole = /^([\d,]+)\.0+$/.exec(amount.trim());
		return whole && exponent(currency) === 0 ? [currency, parseMajor(whole[1]!, currency)] : null;
	}
}

/// One labelled field ("Amount: SGD12.60"), up to the end of its line or the next label.
/// A label's spaces match any run of spaces: Citi prints "Transaction  details"
/// with two (14 Oct 2026), which once sent its alerts to the reader.
const spaced = (label: string) => label.replace(/ +/g, "\\s+");

function field(body: string, label: string, next: readonly string[]): string | null {
	const stop = next.map((n) => `\\s${spaced(n)}\\s*:`).join("|");
	const re = new RegExp(`(?:^|\\s)${spaced(label)}\\s*:\\s*(.+?)(?=${stop ? `${stop}|` : ""}\\n|$)`, "is");
	return re.exec(body)?.[1]?.trim() || null;
}

const OWN = /\b(?:A\/C|Account|card)\s+ending\s+(\d{4})\b/i;

/// DBS / POSB iBanking and digibank alerts: PayNow, NETS, funds transfers and
/// card transactions, all printed as "Date & Time / Amount / From / To".
///   PayNow to a business (UEN)         → purchase
///   NETS QR / Scan & Pay, a card charge → purchase
///   PayNow to a person (mobile, NRIC)  → transfer (the owner's payee rules decide what it is)
///   money in to his account            → income
///   from his account to a card ("Other bank's card ending 5502") → payment:
///                                         a card bill; the engine names the card
///                                         by its digits (14 Oct 2026)
///   anything else (a bill payment, a transfer to an account number) → null: the reader decides.
export function dbsAlert(mail: AlertMail): BuiltInAlert | null {
	const body = mail.body.replace(/\r/g, "");
	const labels = ["Date & Time", "Date and Time", "Amount", "From", "To", "Transaction Ref", "Remarks", "Ref"];
	const amountText = field(body, "Amount", labels);
	const fromText = field(body, "From", labels);
	const toText = field(body, "To", labels);
	if (!amountText || !fromText || !toText) return null;
	const a = /^(S\$|[A-Z]{3})\s?([\d,]+(?:\.\d{2})?)$/i.exec(amountText);
	const amt = a ? money(a[1]!, a[2]!) : null;
	if (!amt) return null;
	const when = field(body, "Date (?:&|and) Time", labels) ?? /\bdated\s+(\d{1,2}\s+[A-Za-z]{3}(?:\s+\d{4})?\s+\d{1,2}:\d{2})/i.exec(body)?.[1] ?? null;
	const dt = when ? /^(\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?)\s*,?\s*(\d{1,2}):(\d{2})/.exec(when) : null;
	const date = dt ? dayMonth(dt[1]!, mail.received_date) : mail.received_date;
	if (!date) return null;
	const time = dt ? `${dt[2]!.padStart(2, "0")}:${dt[3]}` : null;
	const fromOwn = OWN.exec(fromText);
	const toOwn = OWN.exec(toText);
	const [currency, minor] = amt;
	const base = { pattern_id: "builtin-dbs", institution: "dbs", currency, merchant_country: null, txn_date: date, txn_time: time };
	if (fromOwn) {
		const card = /\bcard\s+ending\b/i.test(fromText);
		const uen = /\(\s*UEN\b[^)]*\)/i;
		const nets = /\bNETS\b/i.test(mail.subject) || /\bNETS (?:QR|Pay)\b|Scan\s*&\s*Pay/i.test(body);
		const person = /\(\s*(?:Mobile|NRIC|FIN|VPA|Proxy)\b[^)]*\)/i.test(toText);
		let kind: BuiltInAlert["kind_hint"] | null = null;
		if (card || nets || uen.test(toText)) kind = "purchase";
		else if (person) kind = "transfer";
		else if (/\bcard\s+ending\s+\d{4}\b/i.test(toText)) kind = "payment";
		if (!kind) return null;
		const merchant = kind === "purchase" ? toText.replace(uen, "").trim() : toText;
		if (!merchant) return null;
		return { ...base, kind_hint: kind, amount_minor: minor, last4: fromOwn[1]!, merchant_raw: merchant };
	}
	if (toOwn && !/\bcard\b/i.test(toText)) return { ...base, kind_hint: "income", amount_minor: -minor, last4: toOwn[1]!, merchant_raw: fromText };
	return null;
}

/// Citi Alerts - Credit Card / Ready Credit Transaction:
/// "Account Number: XXXX-XXXX-XXXX-5508 Transaction date: 13/10/26 Transaction time: 16:00:48
///  Transaction amount: SGD10.06 Transaction details: Lazada SG SINGAPORE SGP"
export function citiAlert(mail: AlertMail): BuiltInAlert | null {
	const body = mail.body.replace(/\r/g, "");
	const labels = ["Account Number", "Card Number", "Transaction date", "Transaction time", "Transaction amount", "Transaction details", "Merchant"];
	const acct = field(body, "(?:Account|Card) Number", labels);
	const dateText = field(body, "Transaction date", labels);
	const timeText = field(body, "Transaction time", labels);
	const amountText = field(body, "Transaction amount", labels);
	const details = field(body, "Transaction details", labels);
	if (!acct || !dateText || !amountText || !details) return null;
	const last4 = /(\d{4})\s*$/.exec(acct)?.[1];
	const d = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(dateText);
	const a = /^([A-Z]{3}|S\$)\s?([\d,]+(?:\.\d{2})?)$/i.exec(amountText);
	if (!last4 || !d || !a) return null;
	const y = d[3]!.length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
	const date = iso(y, Number(d[2]), Number(d[1]));
	const amt = money(a[1]!, a[2]!);
	if (!date || !amt) return null;
	const t = timeText ? /^(\d{1,2}):(\d{2})/.exec(timeText) : null;
	const c = /^(.*\S)\s+([A-Z]{3})$/.exec(details);
	const country = c && ISO3[c[2]!] ? ISO3[c[2]!]! : null;
	return {
		pattern_id: "builtin-citi",
		institution: "citi",
		kind_hint: "purchase",
		currency: amt[0],
		amount_minor: amt[1],
		last4,
		merchant_raw: country ? c![1]! : details,
		merchant_country: country,
		txn_date: date,
		txn_time: t ? `${t[1]!.padStart(2, "0")}:${t[2]}` : null,
	};
}

/// HSBC Singapore Transaction Alerts (Credit Card): "…a transaction made on your
/// HSBC credit card. Card Number XXXX-XXXX-XXXX-5502 Transaction Date 10/OCT/2026
/// Transaction Amount SGD 12.34 Merchant …". Labels with or without a colon;
/// any of them missing → null (the reader reads it).
export function hsbcAlert(mail: AlertMail): BuiltInAlert | null {
	const body = mail.body.replace(/\r/g, "").replace(/[ \t]+/g, " ");
	if (!/transaction made on your HSBC credit card/i.test(body)) return null;
	const card = /Card Number\s*:?\s*[X*\d]{4}[- ]?[X*\d]{4}[- ]?[X*\d]{4}[- ]?(\d{4})\b/i.exec(body)?.[1];
	const d = /Transaction Date\s*:?\s*(\d{1,2})[/ -]([A-Za-z]{3})[/ -](\d{4})/i.exec(body);
	// Case-sensitive: the currency is a printed code (SGD), never a word ("Amount of …").
	const a = /(?:[Tt]ransaction )?(?:Amount|AMOUNT|amount)\s*:?\s*([A-Z]{3}|S\$)\s?([\d,]+(?:\.\d{2})?)\b/.exec(body);
	const m = /(?:Merchant(?: Name)?|Description|Transaction Details)\s*:?\s*([^\n]+?)(?=\s+(?:Transaction|Card Number|Amount|If |Please|Should|Thank|This is|Yours|Note)\b|\s*\n|$)/i.exec(body);
	if (!card || !d || !a || !m) return null;
	const month = MONTHS.indexOf(d[2]!.toUpperCase()) + 1;
	const date = month ? iso(Number(d[3]), month, Number(d[1])) : null;
	const amt = money(a[1]!, a[2]!);
	const merchant = m[1]!.trim();
	if (!date || !amt || !merchant) return null;
	const t = /Transaction Time\s*:?\s*(\d{1,2}):(\d{2})/i.exec(body);
	return {
		pattern_id: "builtin-hsbc",
		institution: "hsbc",
		kind_hint: "purchase",
		currency: amt[0],
		amount_minor: amt[1],
		last4: card,
		merchant_raw: merchant,
		merchant_country: null,
		txn_date: date,
		txn_time: t ? `${t[1]!.padStart(2, "0")}:${t[2]}` : null,
	};
}

const BUILT_IN: Readonly<Record<string, (m: AlertMail) => BuiltInAlert | null>> = { dbs: dbsAlert, citi: citiAlert, hsbc: hsbcAlert };

/// The built-in reading of an alert from `bank` (the bank Gmail vouched for); null = not one we know.
export function builtInAlert(bank: string | null, mail: AlertMail): BuiltInAlert | null {
	const read = bank ? BUILT_IN[bank] : undefined;
	if (!read) return null;
	try {
		return read(mail);
	} catch {
		return null;
	}
}
