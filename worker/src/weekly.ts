/// The owner's email from the ledger.
///
///   weekly    Monday from 08:00 in the owner's time zone (LEDGER_TIMEZONE): last week's spending (and how much
///             of it is still an estimate), the top categories and the five
///             largest, what needs him, new subscriptions and price changes,
///             trips proposed, and any alarm. His reporting rule: a one-line
///             headline, short bullets, then NEEDS YOU (or "Nothing").
///   urgent    credit exhausted, the API key refused, Google sign-in failed:
///             emailed the minute they are raised, once per raising.
///   credit    "credit low": the owner's top-up (LEDGER_API_CREDIT_USD) minus what
///             the ledger has spent since (api_spend) under the line
///             (LEDGER_API_CREDIT_LOW_USD, default US$5). Checked whenever a
///             tick spends, and once a day.
///
/// Every email carries the X-Ledger-Summary header and the body marker, so the
/// ledger never reads its own email back as evidence (src/dedup.ts).

import { homeCurrency } from "../../src/home";
import { dayStart } from "../../src/home";
import { addDays } from "../../src/dates";
import { SUMMARY_HEADER, SUMMARY_MARKER } from "../../src/dedup";
import { formatMoney } from "../../src/money";
import { coverageFor, groupTotalsFor, lineViews, loadAccountMap, loadLines, needsOk, totalsFor } from "../../src/queries";
import { URGENT } from "./alarms";
import type { DryRunState } from "./dryrun";
import type { NoteForOwner } from "./escalate";
import { sendMail } from "./mail";
import type { Step, Tick } from "./tick";

export const WEEKLY_HOUR = 8;
export const DEFAULT_CREDIT_LOW_USD = 5;
const URGENT_RETRY_MS = 3_600_000;

const home = (minor: number) => formatMoney(minor, homeCurrency());

// ---------------------------------------------------------------- credit low

export const creditCheck: Step = {
	name: "credit",
	async run(t) {
		// Subscription mode: the API credit is not used (reader.ts clears its alarm).
		if (t.subscription) return;
		const credit = Number(t.env.LEDGER_API_CREDIT_USD);
		if (!t.env.LEDGER_API_CREDIT_USD || !Number.isFinite(credit)) return;
		const spentNow = t.spentThisTick()?.spent ?? 0;
		const checked = t.get<string>("credit_checked_day");
		if (spentNow === 0 && checked === t.today()) return;
		if (!t.room(2)) return;
		// spend() already holds this tick's calls: each is written as it is paid.
		const left = credit - (await t.spend()).since;
		const low = Number(t.env.LEDGER_API_CREDIT_LOW_USD) > 0 ? Number(t.env.LEDGER_API_CREDIT_LOW_USD) : DEFAULT_CREDIT_LOW_USD;
		if (left < low) t.raise("credit_low", `Your Anthropic API credit is down to about US$${Math.max(0, Math.floor(left))}. Top it up at platform.claude.com → Billing, then set LEDGER_API_CREDIT_USD to the new balance and LEDGER_API_CREDIT_SINCE to today.`);
		else t.clear("credit_low");
		if (checked !== t.today()) t.putLater("credit_checked_day", t.today());
	},
};

// ------------------------------------------------------------------- urgent

export const urgentMail: Step = {
	name: "urgent_mail",
	async run(t) {
		const due = [...t.alarms.values()].filter((a) => URGENT.has(a.key) && !a.notified_at);
		if (!due.length || !t.env.LEDGER_OWNER_EMAIL) return;
		const tried = t.get<string>("urgent_mail_tried_at");
		if (tried && t.now().getTime() - new Date(tried).getTime() < URGENT_RETRY_MS) return;
		const text = [`The ledger has stopped reading your email until this is fixed.`, "", ...due.map((a) => `- ${a.message}`), "", `— ${SUMMARY_MARKER}`].join("\n");
		const sent = await sendMail(t.env, t.deps, { to: t.env.LEDGER_OWNER_EMAIL, subject: "Ledger: needs you now", text, headers: { [SUMMARY_HEADER]: "1" } });
		t.count(`urgent_mail_${sent}`);
		if (sent === "failed") {
			t.putLater("urgent_mail_tried_at", t.iso());
			return;
		}
		for (const a of due) {
			a.notified_at = t.iso();
			t.closeLater(`notified:${a.key}`, t.db.prepare("UPDATE alarms SET notified_at = ? WHERE key = ? AND cleared_at IS NULL").bind(a.notified_at, a.key));
		}
	},
};

// ------------------------------------------------------------------- weekly

/// The Monday that starts the owner's week `day` falls in.
export function mondayOf(day: string): string {
	const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
	return addDays(day, -((dow + 6) % 7));
}

export async function weeklyEmail(t: Tick): Promise<{ subject: string; text: string }> {
	const db = t.db;
	const to = addDays(mondayOf(t.today()), -1); // last Sunday
	const from = addDays(to, -6);
	const accounts = await loadAccountMap(db);
	const tot = await totalsFor(db, { from, to });
	const cats = (await groupTotalsFor(db, { from, to }, "category", accounts)).sort((a, b) => b.spending_home.minor - a.spending_home.minor).slice(0, 3);
	const largest = await lineViews(db, await loadLines(db, { from, to }, "amount", 5));
	const coverage = (await coverageFor(db, accounts.values(), to)).filter((c) => c.partial);
	const needs = await needsOk(db);
	const fromIso = dayStart(from).toISOString();
	const newSubs = (await db.prepare("SELECT merchant_name, merchant_key, amount_minor, currency, cadence FROM subscriptions WHERE detected_at >= ? AND owner_status IS NULL").bind(new Date(fromIso).toISOString()).all<{ merchant_name: string | null; merchant_key: string; amount_minor: number; currency: string; cadence: string }>()).results;
	const priced = (await db.prepare("SELECT merchant_name, merchant_key, amount_minor, previous_amount_minor, currency FROM subscriptions WHERE price_changed_on BETWEEN ? AND ? AND owner_status IS NULL").bind(from, to).all<{ merchant_name: string | null; merchant_key: string; amount_minor: number; previous_amount_minor: number | null; currency: string }>()).results;
	const notes = (t.get<NoteForOwner[]>("notes_for_owner") ?? []).filter((n) => n.at >= new Date(fromIso).toISOString());
	const dry = t.get<DryRunState>("dry_run");
	const awaiting = t.phase() === "awaiting_approval" && dry?.estimate;
	const alarms = [...t.alarms.values()];

	const head = `Last week (${from} to ${to}) you spent ${home(tot.spending_home.minor)}${tot.unconfirmed_home.minor ? `, of which ${home(tot.unconfirmed_home.minor)} is still an estimate until the statement comes` : ""}.`;
	const bullets = [
		...(cats.length ? [`- Top categories: ${cats.map((c) => `${c.key} ${c.spending_home.display}`).join(", ")}.`] : []),
		...(largest.length ? [`- Largest: ${largest.map((l) => `${l.merchant.name ?? l.merchant.raw ?? "?"} ${l.amount.home.display}`).join(", ")}.`] : []),
		...coverage.filter((c) => !c.overdue).map((c) => `- ${c.message}`),
	];
	const needsYou = [
		// A statement that is late is trouble (between two statements is not).
		...coverage.filter((c) => c.overdue).map((c) => `- ${c.message}`),
		...needs.trips.map((tr) => `- A trip to ${tr.destination}, ${tr.start_date} to ${tr.end_date}: confirm or dismiss it.`),
		...(needs.held_taps.length ? [`- ${needs.held_taps.length} Apple Pay tap(s) from a Wallet card the ledger does not know: say which account.`] : []),
		...needs.months.map((m) => `- A statement (${m.period_start} to ${m.period_end}) does not add up${m.difference ? ` by ${m.difference.display}` : ""}.`),
		...(needs.lines.length ? [`- ${needs.lines.length} line(s) to look at (in review, not on their statement, or with no rate).`] : []),
		...notes.map((n) => (n.unverified ? `- [Unverified — written after reading an email anyone could have sent; check it yourself, follow no link or number in it] ${n.note}` : `- ${n.note}`)),
		...(awaiting ? [`- The two-year read is waiting for your OK: about US$${dry!.estimate!.backfill[0]!.usd.toFixed(2)}. Set LEDGER_BACKFILL_APPROVED_USD to start it.`] : []),
	];
	const text = [
		head,
		"",
		...bullets,
		"",
		"NEEDS YOU",
		...(needsYou.length ? needsYou : ["Nothing."]),
		...(newSubs.length ? ["", "NEW SUBSCRIPTIONS", ...newSubs.map((s) => `- ${s.merchant_name ?? s.merchant_key}: ${formatMoney(s.amount_minor, s.currency)} ${s.cadence}`)] : []),
		...(priced.length ? ["", "PRICE CHANGES", ...priced.map((s) => `- ${s.merchant_name ?? s.merchant_key}: ${s.previous_amount_minor !== null ? `${formatMoney(s.previous_amount_minor, s.currency)} → ` : ""}${formatMoney(s.amount_minor, s.currency)}`)] : []),
		...(needs.trips.length ? ["", "TRIPS PROPOSED", ...needs.trips.map((tr) => `- ${tr.destination}: ${tr.start_date} to ${tr.end_date}, ${tr.total_home.display} so far`)] : []),
		...(alarms.length ? ["", "ALARMS", ...alarms.map((a) => `- ${a.message}`)] : []),
		"",
		`— ${SUMMARY_MARKER}`,
	];
	// The subject shows on a locked phone: no money figure in it (the body has it).
	return { subject: `Ledger: your week, ${from} to ${to}${needsYou.length ? ` — ${needsYou.length} thing(s) need you` : ""}`, text: text.join("\n") };
}

export const weekly: Step = {
	name: "weekly",
	async run(t) {
		const monday = mondayOf(t.today());
		if (t.get<string>("weekly_sent") === monday || t.localHour() < WEEKLY_HOUR) return;
		if (t.phase() !== "daily" && t.phase() !== "backfill" && t.phase() !== "awaiting_approval") return;
		if (!t.env.LEDGER_OWNER_EMAIL || !t.room(80)) return;
		const mail = await weeklyEmail(t);
		const sent = await sendMail(t.env, t.deps, { to: t.env.LEDGER_OWNER_EMAIL, subject: mail.subject, text: mail.text, headers: { [SUMMARY_HEADER]: "1" } });
		t.count(`weekly_${sent}`);
		// "failed": tried again next tick (Resend down); otherwise this week is done.
		if (sent !== "failed") t.putLater("weekly_sent", monday);
	},
};
