/// Listing Gmail: which emails the ledger reads.
///
/// One Gmail search, by sender domain, Gmail's own "Purchases" category, and
/// receipt-like subjects — never the ledger's own weekly summary. Each page of
/// up to 100 message ids becomes ONE statement that queues the ones not yet
/// read (`work`), in the same batch as the page token, so a tick cut off
/// between pages loses nothing and lists nothing twice.
///
/// The mail check (13 Oct 2026) runs every 15 minutes — during the
/// backfill too, once it has listed the current month (todaysMailPhase), so the ledger follows the owner's spending through the day: it
/// lists only what arrived since an hour before the last check started — one
/// Gmail call and one write when nothing is new. Its progress (`mail_check`)
/// is saved page by page like every listing, so a tick cut off carries on.
///
/// The daily pull stays as the net under it: once a day (the owner's) from 06:00
/// it reaches back two days before the last pull started, so mail Gmail shows
/// late is caught. The overlap is free (already-read messages are skipped by
/// the insert itself).

import { emailAddress } from "../../src/dedup";
import type { Playbook } from "../../src/playbook";
import type { BankList } from "./banks";
import { DEFAULT_FROM } from "./mail";
import type { BackfillState } from "./backfill";
import type { Step, Tick } from "./tick";

/// The owner's banks' mail domains (his bank list, src/bank-list.ts — EVERY
/// domain each bank sends from: DBS alerts went missing after 13 Oct 2026 when
/// one was left out) are always searched, whatever else is; so are the words
/// his list gives for their senders' NAMES ("iBanking Alerts", "digibank
/// Alerts"), which Gmail's from: also finds whatever mailer the bank uses.
/// LISTING IS NOT TRUSTING: what is listed is still sorted by classify() — a
/// sender that is not a bank's own domain, vouched for by Gmail, is never read
/// as a bank alert (at most a receipt, and a bank-named one raises
/// bank_sender_unknown naming its address).
const SUBJECTS = ["receipt", "invoice", '"order confirmation"', '"booking confirmation"', "e-ticket", "itinerary", "收據", "發票"];
/// GrabPay (14 Oct 2026): Grab's e-receipts and the GrabPay Wallet
/// transaction statement — not every Grab advert.
/// Grab's clause is wrapped in its own brackets: Gmail reads `a OR b c` as
/// `(a OR b) AND c`, so the bare `from:grab.com subject:(…)` made EVERY bank's
/// mail need one of these subject words — DBS's "iBanking Alerts" have none, and
/// none reached the ledger from 14 Oct 2026 until this fix (18 Oct).
const GRAB = '(from:grab.com subject:(receipt OR statement OR "top up" OR "top-up" OR transaction OR GrabPay))';
export const OVERLAP_MS = 2 * 24 * 3_600_000;
/// Queries one listed page costs: the insert + the state write (+1 spare).
export const PAGE_COST = 3;

function domainOf(sender: string): string {
	const s = sender.trim().toLowerCase();
	return s.startsWith("@") ? s.slice(1) : s.includes("@") ? s.split("@")[1]! : s;
}

/// A bare domain that can stand in Gmail's from:( … OR … ) as one word. A
/// sender the playbook learned is a model's writing: one with a space, a
/// bracket, a quote or a leading "-" would change what the whole search means
/// ("a OR b c" is not three senders) — so it is left out of the search, never
/// allowed to take the banks' mail down with it.
const SEARCHABLE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const searchable = (domain: string): boolean => SEARCHABLE.test(domain);

/// The sender domains to search: the owner's banks' (always), then the var if
/// set, else every sender the playbook has learned.
export function senderDomains(varValue: string | undefined, book: Playbook | null, banks: BankList): string[] {
	const extra = varValue?.trim()
		? varValue.split(",")
		: book
			? [...book.senders.alerts.map((s) => s.from), ...book.senders.statements.map((s) => s.from), ...book.senders.receipts]
			: [];
	return [...new Set([...banks.searchDomains(), ...extra.map(domainOf).filter(searchable)])];
}

/// The Gmail search for one window. `after`/`before` are instants (Gmail reads
/// epoch seconds). `names`: sender-name words (BankList.searchNames).
export function gmailQuery(domains: readonly string[], names: readonly string[], summaryFrom: string, after: Date, before: Date): string {
	const from = `from:(${[...new Set([...domains.filter(searchable), ...names.filter((w) => /^[a-z0-9]+$/.test(w))])].join(" OR ")})`;
	const subject = `subject:(${SUBJECTS.join(" OR ")})`;
	const secs = (d: Date) => Math.floor(d.getTime() / 1000);
	return `(${from} OR category:purchases OR ${subject} OR ${GRAB}) -from:${emailAddress(summaryFrom)} after:${secs(after)} before:${secs(before)}`;
}

export async function searchFor(t: Tick, after: Date, before: Date): Promise<string> {
	const head = await t.head();
	const banks = t.banks();
	return gmailQuery(senderDomains(t.env.LEDGER_GMAIL_DOMAINS, head?.body ?? null, banks), banks.searchNames(), t.env.LEDGER_MAIL_FROM || DEFAULT_FROM, after, before);
}

export interface Listing {
	q: string;
	page: string | null; // the next page token; null = start (or done when `done`)
	done: boolean;
	listed: number;
}

/// List pages of one search into the work queue until it is done, the budget
/// or the clock runs short, or Gmail stops answering. `save` is the state
/// write that records the listing's progress (in the same batch as the ids).
export async function listInto(t: Tick, listing: Listing, source: "daily" | "backfill", month: string | null, save: (l: Listing) => ReturnType<Tick["put"]>): Promise<Listing> {
	const gmail = t.svc.gmail;
	let l = listing;
	while (!l.done && gmail && !t.gmailStopped && t.room(PAGE_COST)) {
		let page;
		try {
			page = await gmail.list(l.q, l.page ?? undefined);
			t.gmailSucceeded();
		} catch (e) {
			t.gmailFailure(e);
			break;
		}
		l = { ...l, page: page.next, done: page.next === null, listed: l.listed + page.ids.length };
		const now = t.iso();
		const statements = [save(l)];
		if (page.ids.length)
			statements.unshift(
				t.db
					.prepare(
						"INSERT OR IGNORE INTO work (gmail_id, source, month, stage, attempts, created_at, updated_at) " +
							"SELECT value, ?, ?, 'new', 0, ?, ? FROM json_each(?) WHERE value NOT IN (SELECT gmail_id FROM messages)",
					)
					.bind(source, month, now, now, JSON.stringify(page.ids)),
			);
		await t.db.batch(statements);
		t.count("listed", page.ids.length);
		t.count("list_pages");
	}
	return l;
}

/// Is today's mail read in this phase? In the daily reading, yes; during the
/// backfill, once it has listed the current month (its first) — from then on
/// new mail is today's, paid from the daily allowance, never held up by the
/// backfill's progress or its approval running out. Not before the owner approves
/// the backfill (the dry run and the wait for his approval read nothing).
export function todaysMailPhase(t: Tick): boolean {
	const phase = t.phase();
	if (phase === "daily") return true;
	if (phase !== "backfill") return false;
	const b = t.get<BackfillState>("backfill");
	return !b || b.done || b.i > 0 || b.listing?.done === true;
}

/// …and can it be fetched right now?
export function mailFlows(t: Tick): boolean {
	return todaysMailPhase(t) && !!t.svc.gmail && !t.gmailStopped;
}

interface DailyPull extends Listing {
	day: string;
	started_at: string;
}

/// The daily pull: once a day (the owner's) from 06:00 (with the mail check, todaysMailPhase).
export const dailyPull: Step = {
	name: "daily_pull",
	async run(t) {
		if (!mailFlows(t)) return;
		let pull = t.get<DailyPull>("daily_pull");
		if (!pull || pull.done) {
			if ((pull && pull.day === t.today()) || t.localHour() < 6) return;
			// From two days before the last pull started (the first: the backfill's start).
			const from = pull?.started_at ?? t.get<{ started_at?: string }>("backfill")?.started_at ?? t.iso();
			const after = new Date(new Date(from).getTime() - OVERLAP_MS);
			pull = { day: t.today(), started_at: t.iso(), q: await searchFor(t, after, new Date(t.now().getTime() + 3_600_000)), page: null, done: false, listed: 0 };
		}
		const started = pull;
		await listInto(t, pull, "daily", null, (l) => t.put("daily_pull", { ...started, ...l }));
	},
};

/// How often the ledger looks for new mail.
export const CHECK_EVERY_MS = 15 * 60_000;
/// Each check reaches back this far before the last one started: Gmail's search
/// can show a message a little after it arrived (the daily pull's two days are the net under it).
export const CHECK_OVERLAP_MS = 3_600_000;
/// A check that has not finished in this long (Gmail refusing a saved page,
/// say) starts again from the same point instead of being stuck on it.
export const CHECK_RESTART_MS = 3_600_000;

export interface MailCheck extends Listing {
	/// When this check began: the next one reaches back to an hour before it.
	started_at: string;
	/// When a check last finished (every listed message queued): the page's "last checked".
	ok_at: string | null;
}

/// The mail check: every 15 minutes, before anything else (todaysMailPhase).
export const mailCheck: Step = {
	name: "mail_check",
	async run(t) {
		if (!mailFlows(t)) return;
		let check = t.get<MailCheck>("mail_check");
		const age = check ? t.now().getTime() - new Date(check.started_at).getTime() : Infinity;
		if (!check || check.done || age >= CHECK_RESTART_MS) {
			if (check?.done && age < CHECK_EVERY_MS) return;
			// The first check reaches back as far as the daily pull would (nothing is skipped).
			const from = check
				? new Date(check.started_at).getTime() - CHECK_OVERLAP_MS
				: new Date(t.get<{ started_at?: string }>("daily_pull")?.started_at ?? t.get<{ started_at?: string }>("backfill")?.started_at ?? t.iso()).getTime() - OVERLAP_MS;
			check = { started_at: t.iso(), ok_at: check?.ok_at ?? null, q: await searchFor(t, new Date(from), new Date(t.now().getTime() + 3_600_000)), page: null, done: false, listed: 0 };
		}
		const started = check;
		const did = t.did;
		const l = await listInto(t, check, "daily", null, (l) => t.put("mail_check", { ...started, ...l, ok_at: l.done ? t.iso() : started.ok_at }));
		// A check that found nothing new is not worth a line in the run log (96 a day).
		if (l.listed === started.listed && !t.errors.length) t.did = did;
	},
};

/// DBS's alerts stopped reaching the ledger after 13 Oct 2026 (18
/// Oct). The daily pull reaches back only two days, so once the search finds
/// them again, mail from 13 Oct 2026 00:00 (UTC+8, the first owner's) on is listed ONE more time
/// with today's search: whatever was never read is queued (already-read mail
/// is skipped by the insert itself, so nothing is read twice). Runs once per
/// version; a later fix that needs another catch-up bumps the version and,
/// if it must, the start.
/// v2 (18 Oct): v1 ran with the search the Grab clause had narrowed, so it found no iBanking Alerts.
/// A ledger whose backfill began after RELIST_FROM (any new install) read that time
/// itself: it is marked done at once and never lists anything.
export const RELIST_VERSION = 2;
export const RELIST_FROM = "2026-10-13T00:00:00+08:00";

interface Relist extends Listing {
	v: number;
}

export const bankRelist: Step = {
	name: "bank_relist",
	async run(t) {
		if (!mailFlows(t)) return;
		let r = t.get<Relist>("bank_relist");
		if (r?.v === RELIST_VERSION && r.done) return;
		const began = t.get<{ started_at?: string }>("backfill")?.started_at;
		if (!r && began && began >= new Date(RELIST_FROM).toISOString()) {
			t.putLater("bank_relist", { v: RELIST_VERSION, q: "", page: null, done: true, listed: 0 });
			return;
		}
		if (!r || r.v !== RELIST_VERSION) r = { v: RELIST_VERSION, q: await searchFor(t, new Date(RELIST_FROM), new Date(t.now().getTime() + 3_600_000)), page: null, done: false, listed: 0 };
		const started = r;
		const l = await listInto(t, r, "daily", null, (l) => t.put("bank_relist", { ...started, ...l }));
		if (l.done) t.count("bank_relist_listed", l.listed);
	},
};
