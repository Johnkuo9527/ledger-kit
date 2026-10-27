/// Reading OLDER months after the backfill finished (12 Oct 2026).
///
/// LEDGER_BACKFILL_MONTHS counts back from the month the backfill started. When
/// it is raised after the backfill finished, only the months older than what
/// was read are read now — newest of them first, by the senior model (Opus 5.5)
/// exactly like the backfill — while the daily reading (Sonnet 5.5) carries on
/// under its own US$3/day cap. Nothing changes in LEDGER_BACKFILL_MONTHS →
/// nothing happens.
///
///   * Starts only once the owner approves with LEDGER_BACKFILL_EXTRA_APPROVED_USD
///     (separate from the backfill's approval, which is spent). That approval
///     is a TOTAL across every extension: its spend (`backfill_extra_spent`,
///     Tick.recordSpend with pot "extra") is never reset, so a later extension
///     needs the approval raised again.
///   * Waits until the exchange rates reach back far enough (fx-feed.ts fills
///     the older days first).
///   * Reaching the approval pauses it with the `backfill_extra_cap` alarm; the
///     daily reading is not touched. Raising the approval lets it finish.
///   * At the end one senior call ADDS what the older months taught to the
///     playbook — never removes or rewrites what is there.
///   * State `backfill_extra` (sync_state): resumable at every step; a second
///     run of any step finds its work done.

import { homeCurrency } from "../../src/home";
import { addMonths } from "../../src/dates";
import { emptyPlaybook, validatePlaybook } from "../../src/playbook";
import { publishPlaybook } from "../../src/playbook-store";
import { readMonths, type BackfillState } from "./backfill";
import { constrainToList, tickCategories } from "./categorise";
import { monthsBack } from "./dryrun";
import { backfillMonths, fxFromFor, fxReaches } from "./fx-feed";
import { readWith } from "./pipeline";
import { PlaybookSummarySchema } from "./schemas";
import type { Step, Tick } from "./tick";

export interface ExtraState extends BackfillState {
	/// The oldest month read before this run (the months read now are all older).
	reach_before: string;
	/// The first day of rates this run needs.
	fx_from: string;
}

const prevMonth = (month: string) => addMonths(`${month}-01`, -1).slice(0, 7);

/// The older months still to read (newest first), or null: nothing to do.
export function olderMonths(t: Tick): { months: string[]; reach_before: string } | null {
	if (t.phase() !== "daily") return null;
	const b = t.get<BackfillState>("backfill");
	if (!b?.done || !b.months.length) return null;
	const x = t.get<ExtraState>("backfill_extra");
	const covered = x?.done && x.months.length ? x.months.at(-1)! : (x?.reach_before ?? b.months.at(-1)!);
	const target = monthsBack(`${b.months[0]}-01`, backfillMonths(t)).at(-1)!;
	const months: string[] = [];
	for (let m = prevMonth(covered); m >= target; m = prevMonth(m)) months.push(m);
	return months.length ? { months, reach_before: covered } : null;
}

function approved(t: Tick): number {
	// Subscription mode: nothing is paid for, so nothing waits for an approval.
	if (t.subscription) return Number.POSITIVE_INFINITY;
	const n = Number(t.env.LEDGER_BACKFILL_EXTRA_APPROVED_USD);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/// The marker the older months' paragraph opens with in the playbook's summary
/// (also how a publish already made is recognised).
export const olderMarker = (x: Pick<ExtraState, "months">) => `Older months ${x.months.at(-1)} to ${x.months[0]}:`;

async function summariseOlder(t: Tick, x: ExtraState): Promise<"done" | "wait"> {
	const head = await t.head();
	const book = head?.body ?? emptyPlaybook();
	const marker = olderMarker(x);
	if (book.summary.includes(marker)) return "done"; // published, then cut off before it was marked done
	const merchants = (
		await t.db
			.prepare(
				"SELECT merchant_key, MAX(merchant_name) AS name, kind, COUNT(*) AS n, SUM(home_minor) AS home_minor FROM lines " +
					"WHERE state <> 'void' AND txn_date >= ? AND txn_date < ? GROUP BY merchant_key, kind ORDER BY n DESC LIMIT 200",
			)
			.bind(`${x.months.at(-1)}-01`, `${x.reach_before}-01`)
			.all()
	).results;
	const fixed = tickCategories(t);
	const list = fixed.length ? `the owner's own categories — categories and category_rules must use ONLY these, spelled exactly: ${fixed.join(", ")}.\n` : "";
	const user =
		`${list}These are OLDER months (${x.months.at(-1)} to ${x.months[0]}), read after the backfill had already written the playbook. ` +
		`Everything it holds stays; say ONLY what these months add: a short summary of what is new or different in them, categories and category_rules only for merchants the playbook does not cover, own_names not already listed, and judgement_notes / escalate_when only if new (empty when nothing is new).\n` +
		`The playbook's summary now: ${JSON.stringify(book.summary)}\nIts rules cover: ${JSON.stringify(book.category_rules.map((r) => r.merchant_key).slice(0, 300))}\n` +
		`Months read: ${x.months.length}. Their most frequent merchants (key, name, kind, count, ${homeCurrency()} minor units):\n${JSON.stringify(merchants)}`;
	const r = await readWith(t, "senior", "summary", user, PlaybookSummarySchema, 16000, { slot: `older:${x.months.at(-1)}:${x.months[0]}` });
	if (!r.ok && r.why === "blocked") return "wait";
	if (!r.ok) {
		t.count("backfill_extra_summary_failed");
		return "done";
	}
	const categories = [...new Set([...book.categories, ...r.data.categories])];
	const note = r.data.judgement_notes.trim();
	const added = r.data.summary.trim();
	const next = {
		...book,
		summary: [book.summary, `${marker} ${added || "nothing new."}`].filter(Boolean).join("\n\n"),
		categories,
		category_rules: [...book.category_rules, ...r.data.category_rules.filter((c, i, all) => categories.includes(c.category) && !book.category_rules.some((y) => y.merchant_key === c.merchant_key) && all.findIndex((z) => z.merchant_key === c.merchant_key) === i)],
		own_names: [...new Set([...book.own_names, ...r.data.own_names])],
		judgement_notes: note && !book.judgement_notes.includes(note) ? [book.judgement_notes, note].filter(Boolean).join("\n\n") : book.judgement_notes,
		escalate_when: [...new Set([...book.escalate_when, ...r.data.escalate_when])],
	};
	const held = constrainToList(next, fixed);
	if (validatePlaybook(held).length) {
		t.count("backfill_extra_playbook_invalid");
		return "done";
	}
	const pub = await publishPlaybook(t.db, held, head?.version ?? null, "senior", `the older months' summary (${x.months.at(-1)} to ${x.months[0]})`, t.iso());
	t.forgetHead();
	t.count(pub.ok ? "backfill_extra_playbook_published" : "backfill_extra_playbook_conflict");
	return !pub.ok && pub.reason === "conflict" ? "wait" : "done";
}

export const backfillExtra: Step = {
	name: "backfill_extra",
	async run(t) {
		if (t.phase() !== "daily") return;
		let x = t.get<ExtraState>("backfill_extra");
		if (!x || x.done) {
			const want = olderMonths(t);
			if (!want || !approved(t)) return; // nothing to read, or not approved yet: no write, no run row
			x = { months: want.months, i: 0, listing: null, started_at: t.iso(), done: false, reach_before: want.reach_before, fx_from: fxFromFor(want.months.at(-1)!) };
			await t.db.batch([t.put("backfill_extra", x)]);
			t.count("backfill_extra_started");
		}
		if (!fxReaches(t, x.fx_from)) {
			t.count("backfill_extra_waiting_for_rates");
			return;
		}
		if (!(await readMonths(t, "backfill_extra"))) return;

		// Every month listed and read: release what is still parked (a statement
		// that began before the oldest month), wait for the queue, then the summary.
		const months = JSON.stringify(x.months);
		const left = await t.db
			.prepare("SELECT SUM(CASE WHEN stage = 'parked' THEN 1 ELSE 0 END) AS parked, SUM(CASE WHEN stage IN ('new', 'ingest') THEN 1 ELSE 0 END) AS busy FROM work WHERE source = 'backfill' AND month IN (SELECT value FROM json_each(?))")
			.bind(months)
			.first<{ parked: number | null; busy: number | null }>();
		if (left?.parked) {
			await t.db.prepare("UPDATE work SET stage = 'ingest', updated_at = ? WHERE stage = 'parked' AND source = 'backfill' AND month IN (SELECT value FROM json_each(?))").bind(t.iso(), months).run();
			return;
		}
		if (left?.busy) return;
		const done = x;
		if ((await t.withPot("extra", () => summariseOlder(t, done))) === "wait") return;
		await t.db.batch([t.put("backfill_extra", { ...t.get<ExtraState>("backfill_extra")!, done: true })]);
		t.clear("backfill_extra_cap");
		t.count("backfill_extra_done");
	},
};
