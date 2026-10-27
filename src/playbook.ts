/// The playbook: everything the senior model learned about the owner's money that
/// the daily model needs, as one versioned JSON document.
///
///   * The senior model WRITES it — once after the 2-year backfill, then again
///     each time it resolves an escalation. Each write is a new version; old
///     versions are never edited (playbook_versions), and playbook_head points
///     at the one in force.
///   * The daily model only READS the head, sent as cached instructions —
///     only the parts each reading needs (worker/src/read.ts playbookFor,
///     byte-stable, so the cache hits until the version changes).
///   * Bank alerts are read by alert_patterns with NO model call at all
///     (applyAlertPattern below). A new bank format is a playbook edit, not a
///     code deploy.
/// No secret ever goes in here: a statement password is named by the secret
/// that holds it (password_secret), never written.

import { isIsoDate } from "./dates";
import type { MerchantAlias } from "./merchant";
import { parsePrinted } from "./money";
import { currencyOfMark } from "./shortcut";
import { KIND_HINTS, LINE_KINDS, type KindHint, type LineKind } from "./types";

export const PLAYBOOK_SCHEMA = 1;

/// Every bank emails its statement as a password-protected PDF. Each password
/// is a Cloudflare worker secret, one per bank (or per account when two cards
/// at one bank differ): LEDGER_PDF_PW_HSBC, LEDGER_PDF_PW_TAISHIN, … Never in
/// D1, never in the repo, never in the playbook — the playbook only names it.
export const PDF_SECRET_NAME = /^LEDGER_PDF_PW_[A-Z0-9_]+$/;

export function defaultPdfSecretName(institution: string): string {
	return `LEDGER_PDF_PW_${institution.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export interface AlertPattern {
	id: string;
	institution: string;
	from: string; // sender address, or "@domain"
	subject?: string; // regex
	/// Regex over the plain-text body with named groups. Required: amount.
	/// Optional: currency, last4, merchant, date, time, country.
	body: string;
	kind_hint: KindHint;
	default_currency: string; // when the alert prints no currency
	date_format: DateFormat;
	/// The amount moves money the other way (a refund / credit alert).
	credit?: boolean;
}

export type DateFormat = "D MMM YYYY" | "DD/MM/YYYY" | "YYYY/MM/DD" | "YYYY-MM-DD" | "D MMM";

export interface Playbook {
	schema: typeof PLAYBOOK_SCHEMA;
	summary: string; // what the senior model has learned, in plain words
	own_names: string[]; // how the owner's own name appears on transfers ("ALEX SAMPLE")
	senders: {
		alerts: { institution: string; from: string }[];
		/// password_secret NAMES the worker secret holding the PDF password.
		statements: { institution: string; from: string; account_id: string; password_secret: string | null }[];
		receipts: string[]; // sender domains whose mail is a receipt
		ignore: string[]; // senders that are never evidence (marketing)
	};
	alert_patterns: AlertPattern[];
	merchant_aliases: MerchantAlias[];
	categories: string[];
	/// `by: "owner"` = the owner's own word: no model replaces or drops it.
	category_rules: { merchant_key: string; category: string; kind?: LineKind; by?: "owner" }[];
	/// Payees that are people (a PayNow or transfer to someone): what the owner pays
	/// a person for varies, so no rule is guessed for them — he picks per line,
	/// unless he says "always" (then it is his rule like any other).
	person_keys?: string[];
	judgement_notes: string; // free-text guidance for the daily model
	escalate_when: string[]; // when the daily model must hand a case up
}

export function emptyPlaybook(): Playbook {
	return {
		schema: PLAYBOOK_SCHEMA,
		summary: "",
		own_names: [],
		senders: { alerts: [], statements: [], receipts: [], ignore: [] },
		alert_patterns: [],
		merchant_aliases: [],
		categories: [],
		category_rules: [],
		judgement_notes: "",
		escalate_when: [],
	};
}

function compiles(source: string): string | null {
	try {
		new RegExp(source, "u");
		return null;
	} catch (e) {
		return (e as Error).message;
	}
}

/// Every reason this document must not become the head. Empty = valid.
export function validatePlaybook(body: unknown): string[] {
	const problems: string[] = [];
	if (typeof body !== "object" || body === null) return ["the playbook must be a JSON object"];
	const p = body as Partial<Playbook>;
	if (p.schema !== PLAYBOOK_SCHEMA) problems.push(`schema must be ${PLAYBOOK_SCHEMA}`);
	for (const key of ["own_names", "alert_patterns", "merchant_aliases", "categories", "category_rules", "escalate_when"] as const) {
		if (!Array.isArray(p[key])) problems.push(`${key} must be a list`);
	}
	if (typeof p.summary !== "string") problems.push("summary must be text");
	if (typeof p.judgement_notes !== "string") problems.push("judgement_notes must be text");
	const s = p.senders;
	if (!s || !Array.isArray(s.alerts) || !Array.isArray(s.statements) || !Array.isArray(s.receipts) || !Array.isArray(s.ignore)) {
		problems.push("senders needs alerts, statements, receipts and ignore lists");
	} else {
		for (const st of s.statements) {
			if (st.password_secret !== null && !PDF_SECRET_NAME.test(st.password_secret ?? "")) {
				problems.push(`statement sender ${st.from}: password_secret must NAME a worker secret (LEDGER_PDF_PW_<BANK or ACCOUNT>), never hold a password`);
			}
		}
	}
	const ids = new Set<string>();
	for (const pat of p.alert_patterns ?? []) {
		if (ids.has(pat.id)) problems.push(`alert pattern id ${pat.id} is used twice`);
		ids.add(pat.id);
		const err = compiles(pat.body) ?? (pat.subject ? compiles(pat.subject) : null);
		if (err) problems.push(`alert pattern ${pat.id}: ${err}`);
		else if (!/\(\?<amount>/.test(pat.body)) problems.push(`alert pattern ${pat.id}: needs an (?<amount>…) group`);
		if (!(KIND_HINTS as readonly string[]).includes(pat.kind_hint)) problems.push(`alert pattern ${pat.id}: unknown kind_hint ${pat.kind_hint}`);
		if (!/^[A-Z]{3}$/.test(pat.default_currency ?? "")) problems.push(`alert pattern ${pat.id}: default_currency must be a 3-letter code`);
		if (!DATE_FORMATS.includes(pat.date_format)) problems.push(`alert pattern ${pat.id}: unknown date_format ${pat.date_format}`);
	}
	for (const a of p.merchant_aliases ?? []) {
		if (a.pattern.startsWith("/") && a.pattern.endsWith("/") && a.pattern.length > 2) {
			const err = compiles(a.pattern.slice(1, -1));
			if (err) problems.push(`merchant alias ${a.pattern}: ${err}`);
		}
	}
	const cats = new Set(p.categories ?? []);
	for (const r of p.category_rules ?? []) {
		if (!cats.has(r.category)) problems.push(`category rule for ${r.merchant_key}: '${r.category}' is not in categories`);
		if (r.kind && !(LINE_KINDS as readonly string[]).includes(r.kind)) problems.push(`category rule for ${r.merchant_key}: unknown kind ${r.kind}`);
		if (r.by !== undefined && r.by !== "owner") problems.push(`category rule for ${r.merchant_key}: by may only be "owner"`);
	}
	if (p.person_keys !== undefined && (!Array.isArray(p.person_keys) || p.person_keys.some((k) => typeof k !== "string"))) problems.push("person_keys must be a list of merchant keys");
	return problems;
}

/// JSON with keys sorted at every level: the same playbook always produces the
/// same bytes, so its hash is stable and the prompt cache keeps hitting.
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// The whole playbook as one prompt. Byte-stable for a given version. (The
/// worker sends each reading only its parts: worker/src/read.ts playbookFor.)
export function playbookPrompt(version: number, body: Playbook): string {
	return `LEDGER PLAYBOOK v${version}\n${canonicalJson(body)}`;
}

// --------------------------------------------------------- reading an alert

const DATE_FORMATS: readonly DateFormat[] = ["D MMM YYYY", "DD/MM/YYYY", "YYYY/MM/DD", "YYYY-MM-DD", "D MMM"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/// `received` (YYYY-MM-DD) supplies the year for formats that omit it: the
/// year that puts the date on or before the day the email arrived.
export function parseAlertDate(text: string, format: DateFormat, received: string): string | null {
	const t = text.trim().toUpperCase();
	let y: number, m: number, d: number;
	let match: RegExpExecArray | null;
	switch (format) {
		case "D MMM YYYY":
		case "D MMM":
			match = /^(\d{1,2})\s*([A-Z]{3})[A-Z]*\s*(\d{4})?$/.exec(t);
			if (!match) return null;
			d = Number(match[1]);
			m = MONTHS.indexOf(match[2]!) + 1;
			y = match[3] ? Number(match[3]) : Number(received.slice(0, 4));
			if (m === 0) return null;
			break;
		case "DD/MM/YYYY":
			match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
			if (!match) return null;
			[d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
			break;
		case "YYYY/MM/DD":
		case "YYYY-MM-DD":
			match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(t);
			if (!match) return null;
			[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
			break;
	}
	let iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
	if (format === "D MMM" && iso > received) iso = `${y - 1}${iso.slice(4)}`;
	return isIsoDate(iso) ? iso : null;
}

export interface ParsedAlert {
	pattern_id: string;
	institution: string;
	kind_hint: KindHint;
	currency: string;
	amount_minor: number; // signed: + money out
	last4: string | null;
	merchant_raw: string | null;
	merchant_country: string | null;
	txn_date: string;
	txn_time: string | null;
}

/// The first pattern that fits this email, applied. null = no pattern fits —
/// the daily model reads it instead (and may escalate an unknown format).
export function applyAlertPattern(
	patterns: readonly AlertPattern[],
	email: { from: string; subject: string; body: string; received_date: string },
): ParsedAlert | null {
	const from = email.from.toLowerCase();
	for (const p of patterns) {
		const sender = p.from.toLowerCase();
		if (sender.startsWith("@") ? !from.endsWith(sender) : from !== sender) continue;
		if (p.subject && !new RegExp(p.subject, "u").test(email.subject)) continue;
		const g = new RegExp(p.body, "u").exec(email.body)?.groups;
		if (!g?.amount) continue;
		const currency = currencyOfMark(g.currency ?? p.default_currency);
		if (!currency) continue;
		let amount: number;
		try {
			// Any locale's print: "12.50", "12,50", "1.234,56", "JPY 1,200.00" (src/money.ts).
			amount = parsePrinted(g.amount, currency);
		} catch {
			continue;
		}
		const date = g.date ? parseAlertDate(g.date, p.date_format, email.received_date) : email.received_date;
		if (!date) continue;
		return {
			pattern_id: p.id,
			institution: p.institution,
			kind_hint: p.kind_hint,
			currency,
			amount_minor: p.credit ? -Math.abs(amount) : Math.abs(amount),
			last4: g.last4 ?? null,
			merchant_raw: g.merchant?.trim() ?? null,
			merchant_country: g.country?.trim().toUpperCase() ?? null,
			txn_date: date,
			txn_time: g.time ?? null,
		};
	}
	return null;
}
