/// The backfill: two years of the owner's email read into
/// the ledger by the senior model (Opus 5.5), newest month first, once he has
/// approved the dry run's estimate by setting LEDGER_BACKFILL_APPROVED_USD.
///
///   * Waits until two years of exchange rates are in (fx-feed.ts).
///   * Per month: list it into the work queue → the queue reads its alerts
///     and receipts → statements that START in that month or later are
///     released for import (their alerts are all in by then; a statement read
///     earlier waits 'parked').
///   * Spend: each paid call is added to `backfill_spent` the moment it is
///     paid (Tick.recordSpend); the approval minus that is the tick's cap, and reaching it pauses the backfill with
///     an alarm (raise the approval to let it finish).
///   * After the last month, one senior call writes the playbook's summary,
///     categories, rules and the owner's own names from what was read; then the
///     daily reading (Sonnet 5.5) takes over.

import { homeCurrency } from "../../src/home";
import { constrainToList, tickCategories } from "./categorise";
import { emptyPlaybook, validatePlaybook } from "../../src/playbook";
import { publishPlaybook } from "../../src/playbook-store";
import { MARGIN, monthsBack, monthWindow, remainingUsd, type DryRunState } from "./dryrun";
import { backfillMonths, fxFilled } from "./fx-feed";
import { readWith } from "./pipeline";
import { listInto, searchFor, type Listing } from "./pull";
import { PlaybookSummarySchema } from "./schemas";
import type { Step, Tick } from "./tick";

export interface BackfillState {
	months: string[]; // newest first
	i: number;
	listing: Listing | null;
	started_at: string;
	done: boolean;
}

function approved(t: Tick): number {
	// Subscription mode: nothing is paid for, so nothing waits for an approval.
	if (t.subscription) return Number.POSITIVE_INFINITY;
	const n = Number(t.env.LEDGER_BACKFILL_APPROVED_USD);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

async function summarise(t: Tick, b: BackfillState): Promise<"done" | "wait"> {
	const merchants = (
		await t.db
			.prepare("SELECT merchant_key, MAX(merchant_name) AS name, kind, COUNT(*) AS n, SUM(home_minor) AS home_minor FROM lines WHERE state <> 'void' GROUP BY merchant_key, kind ORDER BY n DESC LIMIT 200")
			.bind()
			.all()
	).results;
	const head = await t.head();
	const book = head?.body ?? emptyPlaybook();
	const fixed = tickCategories(t);
	const list = fixed.length ? `the owner's own categories — categories and category_rules must use ONLY these, spelled exactly: ${fixed.join(", ")}.\n` : "";
	const user = `${list}Months read: ${b.months.length}. The most frequent merchants (key, name, kind, count, ${homeCurrency()} minor units):\n${JSON.stringify(merchants)}`;
	const r = await readWith(t, "senior", "summary", user, PlaybookSummarySchema, 16000, { slot: "backfill" });
	if (!r.ok && r.why === "blocked") return "wait";
	if (r.ok) {
		const categories = [...new Set([...book.categories, ...r.data.categories])];
		const next = {
			...book,
			summary: r.data.summary,
			categories,
			category_rules: [...book.category_rules, ...r.data.category_rules.filter((x) => categories.includes(x.category) && !book.category_rules.some((y) => y.merchant_key === x.merchant_key))],
			own_names: [...new Set([...book.own_names, ...r.data.own_names])],
			judgement_notes: r.data.judgement_notes,
			escalate_when: r.data.escalate_when,
		};
		// The owner's own list holds (LEDGER_CATEGORIES): the summary's categories outside it are dropped;
		// the merchants they covered are sorted into his list by sortMerchants.
		const held = constrainToList(next, fixed);
		if (!validatePlaybook(held).length) {
			const pub = await publishPlaybook(t.db, held, head?.version ?? null, "senior", "the backfill's summary", t.iso());
			t.forgetHead();
			t.count(pub.ok ? "backfill_playbook_published" : "backfill_playbook_conflict");
			if (!pub.ok && pub.reason === "conflict") return "wait";
		} else t.count("backfill_playbook_invalid");
	} else t.count("backfill_summary_failed");
	return "done";
}

/// The month-by-month walk the backfill and the older months' reading share
/// (state key "backfill" or "backfill_extra"): list a month into the work
/// queue, wait for the queue to read it, release the statements parked until
/// it, next month. True once every month is listed and read, with room left.
export async function readMonths(t: Tick, key: "backfill" | "backfill_extra"): Promise<boolean> {
	let b = t.get<BackfillState>(key)!;
	while (b.i < b.months.length && t.room(10)) {
		const month = b.months[b.i]!;
		if (!b.listing?.done) {
			const { after, before } = monthWindow(month);
			// The backfill's newest month runs up to now; the older months end at their month's end.
			const until = key === "backfill" && b.i === 0 ? new Date(t.now().getTime() + 3_600_000) : before;
			const start: Listing = b.listing ?? { q: await searchFor(t, after, until), page: null, done: false, listed: 0 };
			const l = await listInto(t, start, "backfill", month, (x) => t.put(key, { ...t.get<BackfillState>(key)!, listing: x }));
			b = t.get<BackfillState>(key)!;
			if (!l.done) return false;
		}
		const open = await t.db.prepare("SELECT COUNT(*) AS n FROM work WHERE source = 'backfill' AND month = ? AND stage = 'new'").bind(month).first<{ n: number }>();
		if ((open?.n ?? 0) > 0) return false; // the work queue is still reading this month
		b = { ...b, i: b.i + 1, listing: null };
		await t.db.batch([
			t.db.prepare("UPDATE work SET stage = 'ingest', updated_at = ? WHERE stage = 'parked' AND park_until_month >= ?").bind(t.iso(), month),
			t.put(key, b),
		]);
		t.count(key === "backfill" ? "backfill_months" : "backfill_extra_months");
	}
	return b.i >= b.months.length && t.room(20);
}

const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

/// The backfill_cap alarm in the owner's words: what is left, what finishing should
/// cost, and that new mail is not held up meanwhile.
export async function backfillCapMessage(t: Tick): Promise<string> {
	const b = t.get<BackfillState>("backfill");
	const spent = t.backfillSpent();
	const row = await t.db
		.prepare("SELECT SUM(CASE WHEN kind = 'statement' THEN 1 ELSE 0 END) AS statements, SUM(CASE WHEN kind IS NOT 'statement' THEN 1 ELSE 0 END) AS other FROM work WHERE source = 'backfill' AND stage IN ('new', 'waiting')")
		.bind()
		.first<{ statements: number | null; other: number | null }>();
	const statements = row?.statements ?? 0;
	const other = row?.other ?? 0;
	const months = b ? b.months.slice(b.i) : [];
	const parts = [
		...(statements ? [`${statements} bank statement${statements === 1 ? "" : "s"}`] : []),
		...(other ? [`${other} other email${other === 1 ? "" : "s"}`] : []),
		...(months.length ? [`${months.length} month${months.length === 1 ? "" : "s"} of email (${months.length === 1 ? monthName(months[0]!) : `${monthName(months[months.length - 1]!)} to ${monthName(months[0]!)}`})`] : []),
	];
	const model = t.env.LEDGER_MODEL_SENIOR || "claude-opus-5-5";
	const more = remainingUsd(model, t.get<DryRunState>("dry_run") ?? null, months, statements + Math.ceil(other / 10)) * (1 + MARGIN);
	const raiseTo = Math.ceil(spent + more);
	return (
		`The two-year backfill has spent US$${spent.toFixed(2)} of the US$${approved(t).toFixed(2)} you approved and has paused.` +
		(parts.length ? ` Still to read: ${parts.join(" and ")}.` : " Only its closing summary is left.") +
		` Finishing should cost about US$${more.toFixed(2)} more — to let it finish, raise LEDGER_BACKFILL_APPROVED_USD to US$${raiseTo}.` +
		" Your new mail is not held up meanwhile: today's bank alerts and card charges are still read every 15 minutes, paid from the daily allowance."
	);
}

export const backfill: Step = {
	name: "backfill",
	async run(t) {
		const phase = t.phase();
		if (phase === "awaiting_approval") {
			if (!approved(t)) return;
			const b: BackfillState = { months: monthsBack(t.today(), backfillMonths(t)), i: 0, listing: null, started_at: t.iso(), done: false };
			await t.db.batch([t.put("backfill", b), t.put("backfill_spent", "0"), t.put("phase", "backfill")]);
			t.clear("backfill_cap");
			t.count("backfill_started");
		} else if (phase !== "backfill") return;

		// Paused at the owner's approval: keep the alarm's words current (what is left, what finishing costs).
		if (t.isOpen("backfill_cap") && t.room(4)) t.raise("backfill_cap", await backfillCapMessage(t));

		if (!fxFilled(t)) {
			t.count("backfill_waiting_for_rates");
			return;
		}

		const b = t.get<BackfillState>("backfill")!;
		if (!(await readMonths(t, "backfill"))) return;

		// Every month listed and read: release anything still parked (a
		// statement that began before the oldest month), wait for the queue.
		// (Parked: today's statements too, held for the backfill's months — busy: the backfill's own.)
		const left = await t.db.prepare("SELECT SUM(CASE WHEN stage = 'parked' THEN 1 ELSE 0 END) AS parked, SUM(CASE WHEN source = 'backfill' AND stage IN ('new', 'ingest') THEN 1 ELSE 0 END) AS busy FROM work WHERE source IN ('backfill', 'daily')").bind().first<{ parked: number | null; busy: number | null }>();
		if (left?.parked) {
			await t.db.prepare("UPDATE work SET stage = 'ingest', updated_at = ? WHERE stage = 'parked'").bind(t.iso()).run();
			return;
		}
		if (left?.busy) return;
		if ((await summarise(t, b)) === "wait") return;
		await t.db.batch([t.put("backfill", { ...t.get<BackfillState>("backfill")!, done: true }), t.put("phase", "daily")]);
		t.count("backfill_done");
	},
};
