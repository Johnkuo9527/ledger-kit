/// The dry run: before a cent is spent on Claude, the
/// worker COUNTS two years of the owner's bank email — no model at all — and
/// emails him what reading it would cost, with Opus 5.5 and with Sonnet 5.5.
/// Nothing is read into the ledger until he approves by setting
/// LEDGER_BACKFILL_APPROVED_USD (which is also the backfill's spend cap).
///
/// Counting is free: Gmail listing, fetching each message, opening each PDF
/// with the owner's passwords (which also tells him, before approving, whether
/// every bank's password works). It is resumable: the month, the Gmail page
/// and the ids still to count are kept in sync_state between ticks.

import { dayStart } from "../../src/home";
import { addMonths } from "../../src/dates";
import { emailAddress, isOwnSummary, SUMMARY_HEADER, SUMMARY_MARKER } from "../../src/dedup";
import { estimateTokens, PRICES, priceOf, type Price } from "./claude";
import { backfillMonths } from "./fx-feed";
import { DEFAULT_FROM, sendMail } from "./mail";
import { unlockWithAny } from "./pdf";
import { noteBankCheck, pdfPasswords } from "./pipeline";
import { searchFor } from "./pull";
import { classify, ignoreSubjects, institutionOf, MAX_EMAIL_CHARS, MAX_STATEMENT_CHARS } from "./read";
import type { Step, Tick } from "./tick";

export const MESSAGES_PER_TICK = 150;
export const PDFS_PER_TICK = 10;
/// The instructions + playbook sent with every call (cached after the first).
export const SYSTEM_TOKENS = 1200;
/// A sender's alerts are read by the model until it has a pattern (after 5),
/// then about 1 in 10 still falls through to the model.
export const PATTERN_AFTER = 5;
export const FALLBACK_SHARE = 0.1;
export const MARGIN = 0.3;

export interface MonthCount {
	month: string; // YYYY-MM
	alerts: number;
	receipts: number;
	statements: number;
	ignored: number;
	pdfs: number;
	pages: number;
	alert_chars: number;
	receipt_chars: number;
	pdf_chars: number;
	alert_senders: Record<string, number>;
}

export interface DryRunState {
	months: MonthCount[]; // newest first
	i: number; // the month being counted
	page: string | null; // the next Gmail page token for that month
	listed: boolean; // that month's listing is finished
	ids: string[]; // listed, not yet counted
	passwords: Record<string, "ok" | "wrong" | "missing">;
	done: boolean;
	estimate: Estimate | null;
	emailed_at: string | null;
}

export interface ModelEstimate {
	model: string;
	usd: number;
	low: number;
	high: number;
}
export interface Estimate {
	backfill: ModelEstimate[]; // Opus 5.5 and Sonnet 5.5
	monthly_daily: { model: string; usd: number };
	totals: { alerts: number; receipts: number; statements: number; pdfs: number; pages: number };
}

/// Calendar months on the owner's calendar, newest first: this month and the N−1 before.
export function monthsBack(today: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => addMonths(`${today.slice(0, 7)}-01`, -i).slice(0, 7));
}

/// The instants the owner's month starts and ends (daylight saving included).
export function monthWindow(month: string): { after: Date; before: Date } {
	return { after: dayStart(`${month}-01`), before: dayStart(`${addMonths(`${month}-01`, 1).slice(0, 7)}-01`) };
}

function emptyMonth(month: string): MonthCount {
	return { month, alerts: 0, receipts: 0, statements: 0, ignored: 0, pdfs: 0, pages: 0, alert_chars: 0, receipt_chars: 0, pdf_chars: 0, alert_senders: {} };
}

const tok = (chars: number) => Math.ceil(chars / 3.5);

/// What a set of calls costs on one model: the system prompt written to the
/// cache once per task, read from it after.
function callsUsd(p: Price, calls: number, inputTokens: number, outputTokens: number): number {
	if (calls <= 0) return 0;
	return (SYSTEM_TOKENS * p.cache_write + (calls - 1) * SYSTEM_TOKENS * p.cache_read + inputTokens * p.input + outputTokens * p.output) / 1e6;
}

function costOn(model: string, months: readonly MonthCount[], fallbackOnly: boolean): number {
	const p = priceOf(model);
	const alerts = months.reduce((s, m) => s + m.alerts, 0);
	const senders: Record<string, number> = {};
	for (const m of months) for (const [k, v] of Object.entries(m.alert_senders)) senders[k] = (senders[k] ?? 0) + v;
	const alertCalls = fallbackOnly
		? Math.ceil(alerts * FALLBACK_SHARE)
		: Object.values(senders).reduce((s, n) => s + Math.min(n, PATTERN_AFTER) + Math.ceil(FALLBACK_SHARE * Math.max(0, n - PATTERN_AFTER)), 0);
	const alertAvg = alerts ? tok(months.reduce((s, m) => s + m.alert_chars, 0)) / alerts : 0;
	const receipts = months.reduce((s, m) => s + m.receipts, 0);
	const receiptTokens = tok(months.reduce((s, m) => s + m.receipt_chars, 0));
	const pdfs = months.reduce((s, m) => s + m.pdfs, 0);
	const pdfTokens = tok(months.reduce((s, m) => s + m.pdf_chars, 0));
	// A statement's answer is about half its text again; 15% are read twice (did not add up).
	const stmt = callsUsd(p, pdfs, pdfTokens + pdfs * 100, Math.ceil(pdfTokens * 0.5) + pdfs * 500) * 1.15;
	return callsUsd(p, alertCalls, Math.ceil(alertCalls * (alertAvg + 100)), alertCalls * 400) + callsUsd(p, receipts, receiptTokens + receipts * 100, receipts * 700) + stmt;
}

/// What finishing a paused backfill should cost on `model` (US$, before any
/// margin): the months not yet read (at the dry run's counts), the statements
/// already found but not yet read (at the dry run's average statement size, or
/// a typical one), and the closing summary call.
export function remainingUsd(model: string, dry: Pick<DryRunState, "months"> | null, monthsLeft: readonly string[], statementsLeft: number): number {
	const p = priceOf(model);
	const counted = dry?.months ?? [];
	const left = counted.filter((m) => monthsLeft.includes(m.month));
	const pdfs = counted.reduce((s, m) => s + m.pdfs, 0);
	const avg = pdfs ? tok(counted.reduce((s, m) => s + m.pdf_chars, 0)) / pdfs : tok(9000);
	const statements = statementsLeft * callsUsd(p, 1, avg + 100, avg * 0.5 + 500) * 1.15;
	return costOn(model, left, false) + statements + (30_000 * p.input + 4_000 * p.output) / 1e6;
}

export function estimate(months: readonly MonthCount[], dailyModel: string): Estimate {
	const round = (x: number) => Math.round(x * 100) / 100;
	const backfill = Object.keys(PRICES).map((model) => {
		// + the closing summary call (two years of merchants in, the playbook out)
		const usd = costOn(model, months, false) + (30_000 * priceOf(model).input + 4_000 * priceOf(model).output) / 1e6;
		return { model, usd: round(usd), low: round(usd * (1 - MARGIN)), high: round(usd * (1 + MARGIN)) };
	});
	const recent = months.slice(1, 4).length ? months.slice(1, 4) : months.slice(0, 1);
	const monthly = recent.length ? costOn(dailyModel, recent, true) / recent.length : 0;
	const sum = (k: "alerts" | "receipts" | "statements" | "pdfs" | "pages") => months.reduce((s, m) => s + m[k], 0);
	return { backfill, monthly_daily: { model: dailyModel, usd: round(monthly) }, totals: { alerts: sum("alerts"), receipts: sum("receipts"), statements: sum("statements"), pdfs: sum("pdfs"), pages: sum("pages") } };
}

const NAMES: Record<string, string> = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5" };
const nameOf = (model: string) => NAMES[model] ?? model;
const usd = (x: number) => `US$${x.toFixed(2)}`;

/// The email the owner gets once the counting is done (his reporting rule: one
/// headline, short bullets, then what needs him).
export function dryRunEmail(s: DryRunState, months: number): { subject: string; text: string } {
	const e = s.estimate!;
	const [first, ...rest] = e.backfill;
	const headline = `Reading your last ${months} months of bank email would cost about ${usd(first!.usd)} with ${nameOf(first!.model)}${rest.map((r) => `, or about ${usd(r.usd)} with ${nameOf(r.model)}`).join("")}.`;
	const pw = Object.entries(s.passwords);
	const bad = pw.filter(([, v]) => v !== "ok");
	const lines = [
		headline,
		"",
		`- Found ${e.totals.alerts} bank alerts, ${e.totals.receipts} receipts and ${e.totals.statements} statement emails (${e.totals.pdfs} PDFs, ${e.totals.pages} pages).`,
		...e.backfill.map((b) => `- ${nameOf(b.model)}: between ${usd(b.low)} and ${usd(b.high)}.`),
		`- After that, reading new email each day should cost about ${usd(e.monthly_daily.usd)} a month on ${nameOf(e.monthly_daily.model)}.`,
		pw.length ? `- Statement passwords: ${pw.map(([bank, v]) => `${bank} ${v === "ok" ? "opened" : v === "wrong" ? "WRONG password" : "no password set"}`).join(", ")}.` : "- No statement PDFs were found.",
		"",
		"NEEDS YOU",
		...bad.map(([bank]) => `- Set the ${bank} statement password before approving: npx wrangler secret put LEDGER_PDF_PW_${bank} -c ../wrangler.toml`),
		`- To start, set LEDGER_BACKFILL_APPROVED_USD to the most you are willing to spend (the higher figure above, rounded up, is safe). The backfill reads with ${nameOf(first!.model)} and pauses if it reaches that amount.`,
		"",
		`— ${SUMMARY_MARKER}`,
	];
	return { subject: `Your ledger: two years of email counted — about ${usd(first!.usd)} to read, needs your OK`, text: lines.join("\n") };
}

function initial(t: Tick): DryRunState {
	return { months: monthsBack(t.today(), backfillMonths(t)).map(emptyMonth), i: 0, page: null, listed: false, ids: [], passwords: {}, done: false, estimate: null, emailed_at: null };
}

async function countOne(t: Tick, s: DryRunState, id: string, budget: { pdfs: number }): Promise<boolean> {
	const g = t.svc.gmail!;
	const m = await g.message(id);
	const head = await t.head();
	const cur = s.months[s.i]!;
	if (isOwnSummary({ from: m.from, subject: m.subject, headers: m.headers, body: m.text }, emailAddress(t.env.LEDGER_MAIL_FROM || DEFAULT_FROM))) return true;
	const kind = classify(m, head?.body ?? null, t.banks(), ignoreSubjects(t.env.LEDGER_IGNORE_SUBJECTS));
	noteBankCheck(t, m, head?.body ?? null, kind);
	if (kind === "ignored") cur.ignored++;
	else if (kind === "alert") {
		cur.alerts++;
		cur.alert_chars += Math.min(m.text.length, MAX_EMAIL_CHARS) + m.subject.length + 80;
		const from = emailAddress(m.from);
		cur.alert_senders[from] = (cur.alert_senders[from] ?? 0) + 1;
	} else if (kind === "receipt") {
		cur.receipts++;
		cur.receipt_chars += Math.min(m.text.length, MAX_EMAIL_CHARS) + m.subject.length + 80;
	} else {
		if (budget.pdfs - m.pdfs.length < 0 || t.pdfsLeft < m.pdfs.length) return false; // the PDFs wait for the next tick (CPU guard)
		budget.pdfs -= m.pdfs.length;
		t.pdfsLeft -= m.pdfs.length;
		cur.statements++;
		const institution = institutionOf(emailAddress(m.from), head?.body ?? null, t.banks()) ?? "other";
		const bank = institution.toUpperCase();
		const accounts = (await t.db.prepare("SELECT id FROM accounts WHERE institution = ? AND has_statements = 1").bind(institution).all<{ id: string }>()).results.map((a) => a.id);
		for (const pdf of m.pdfs) {
			const pw = pdfPasswords(t, institution, accounts, head);
			const text = await unlockWithAny(await g.attachment(m.id, pdf.attachment_id), pw.values);
			cur.pdfs++;
			if (text.ok) {
				cur.pages += text.page_count;
				cur.pdf_chars += Math.min(text.chars, MAX_STATEMENT_CHARS);
				s.passwords[bank] = "ok";
			} else if (text.reason === "wrong_password" || text.reason === "needs_password") {
				if (s.passwords[bank] !== "ok") s.passwords[bank] = pw.values.length ? "wrong" : "missing";
				// Not readable yet: counted at a typical statement's size so the estimate is not too low.
				cur.pages += 3;
				cur.pdf_chars += 9000;
			}
		}
	}
	return true;
}

export const dryRun: Step = {
	name: "dry_run",
	async run(t) {
		if (!t.svc.gmail) return;
		const phase = t.phase();
		if (phase === null) {
			t.putLater("phase", "dry_run");
			t.state.set("phase", "dry_run");
		} else if (phase !== "dry_run") return;
		const s = t.get<DryRunState>("dry_run") ?? initial(t);
		const budget = { pdfs: PDFS_PER_TICK };
		let counted = 0;
		try {
			while (!s.done && !t.gmailStopped && t.timeLeft() && counted < MESSAGES_PER_TICK) {
				if (!s.ids.length) {
					if (s.listed) {
						s.i++;
						s.page = null;
						s.listed = false;
						if (s.i >= s.months.length) s.done = true;
						continue;
					}
					const { after, before } = monthWindow(s.months[s.i]!.month);
					const page = await t.svc.gmail.list(await searchFor(t, after, before), s.page ?? undefined);
					t.gmailSucceeded();
					s.ids = page.ids;
					s.page = page.next;
					s.listed = page.next === null;
					continue;
				}
				if (!(await countOne(t, s, s.ids[0]!, budget))) break;
				s.ids.shift();
				counted++;
			}
		} catch (e) {
			t.gmailFailure(e);
		}
		if (counted) t.count("dry_run_counted", counted);
		if (s.done && !s.estimate) s.estimate = estimate(s.months, t.env.LEDGER_MODEL_DAILY || "claude-sonnet-5-5");
		if (s.done && !s.emailed_at) {
			// No email set up: the estimate still shows on his page (GET /api/status).
			const mail = dryRunEmail(s, s.months.length);
			const sent = t.env.LEDGER_OWNER_EMAIL ? await sendMail(t.env, t.deps, { to: t.env.LEDGER_OWNER_EMAIL, subject: mail.subject, text: mail.text, headers: { [SUMMARY_HEADER]: "1" } }) : "not_configured";
			if (sent === "sent" || sent === "not_configured") s.emailed_at = t.iso();
			t.count(`dry_run_email_${sent}`);
		}
		t.putLater("dry_run", s);
		if (s.done && s.emailed_at) t.putLater("phase", "awaiting_approval");
	},
};
