/// The senior model's daily look at what the engine could not settle
///: up to five open escalations a day (the owner's day), each
/// with its context, answered in ONE call. Its answer per escalation:
///
///   resolved        closed, against the playbook version its edits made
///   reprocess       that email is read again from the start (after the edits)
///   note_for_owner   left open; the note goes in the owner's weekly email
///
/// Its playbook edits (new senders, merchant names, category rules, the owner's
/// own names, guidance) are applied, validated, and published as a new
/// version — or not at all if they do not validate.

import { constrainToList, tickCategories } from "./categorise";
import { emptyPlaybook, validatePlaybook, type Playbook } from "../../src/playbook";
import { publishPlaybook } from "../../src/playbook-store";
import { readWith } from "./pipeline";
import { BankList, domainOf, tooBroad } from "./banks";
import { emailPrompt, fence } from "./read";
import { isUploadId } from "../../src/upload-status";
import { EscalationSchema, type EscalationAnswer } from "./schemas";
import type { Step, Tick } from "./tick";

export const ESCALATIONS_PER_DAY = 5;
const CHECK_EVERY_MS = 3_600_000;
/// Escalations the engine logs for the record or that only the owner can settle.
const NOT_FOR_THE_MODEL = ["learned_card_number", "unknown_wallet_card"];

interface EscState {
	day: string;
	sent: number;
	asked: string[];
	checked_at: string;
}

export interface NoteForOwner {
	escalation_id: string;
	note: string;
	at: string;
	/// Written by the model after reading an email anyone could have sent:
	/// the weekly email says so.
	unverified?: boolean;
}

interface Esc {
	id: string;
	kind: string;
	ref_id: string | null;
	reason: string;
	created_at: string;
}

/// Escalations whose text the engine wrote itself. Every other kind carries
/// something an email (or a model reading one) wrote: the batch is then
/// UNTRUSTED — anyone can email the owner — and its edits are fenced (applyEdits).
const ENGINE_ONLY = new Set(["match_ambiguous", "line_unsure", "month_failed"]);

export const NOTE_MAX_CHARS = 300;

/// A note for the owner's weekly email, as plain text: one line, no control or
/// direction-changing characters, no links, capped.
export function plainNote(note: string): string {
	return note
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ")
		.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, "[link removed]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, NOTE_MAX_CHARS);
}

/// The playbook with the senior model's edits applied (pure). Whatever the
/// model says, it can never:
///   * ignore, or list as a receipt sender, any bank's mail (or a sender
///     already known as a bank's), nor a whole top-level or freemail domain;
///   * add an alerts sender outside the four banks' own domains (the
///     institution is then the bank that domain belongs to, not its say-so).
/// From an UNTRUSTED batch (email-derived text in its context) it also cannot
/// change who is trusted at all (no alerts or ignore senders), nor add the owner's
/// own names or free-text guidance for the daily reader.
export function applyEdits(book: Playbook, edits: NonNullable<EscalationAnswer["playbook_edits"]>, banks: BankList, untrusted = true, refused: (what: string) => void = () => {}): Playbook {
	const next: Playbook = structuredClone(book);
	const knownBank = [...next.senders.alerts.map((a) => a.from), ...next.senders.statements.map((s) => s.from)];
	for (const s of edits.add_senders) {
		const from = s.from.trim().toLowerCase();
		if (untrusted && s.kind !== "receipts") {
			refused(`sender_${s.kind}_untrusted`);
			continue;
		}
		if (s.kind === "alerts") {
			const bank = banks.bankOfDomain(domainOf(from));
			if (!bank) {
				refused("sender_alerts_not_a_bank");
				continue;
			}
			if (!next.senders.alerts.some((a) => a.from === from)) next.senders.alerts.push({ institution: bank, from });
			continue;
		}
		if (banks.touches(from, knownBank) || tooBroad(from)) {
			refused(`sender_${s.kind}_refused`);
			continue;
		}
		if (s.kind === "receipts" && !next.senders.receipts.includes(from)) next.senders.receipts.push(from);
		if (s.kind === "ignore" && !next.senders.ignore.includes(from)) next.senders.ignore.push(from);
	}
	for (const a of edits.add_merchant_aliases) if (!next.merchant_aliases.some((x) => x.pattern === a.pattern)) next.merchant_aliases.push({ pattern: a.pattern, canonical: a.canonical });
	for (const r of edits.add_category_rules) {
		// A rule the owner set is his word: a model never replaces it.
		if (next.category_rules.some((x) => x.merchant_key === r.merchant_key && x.by === "owner")) {
			refused("category_rule_owner");
			continue;
		}
		if (!next.categories.includes(r.category)) next.categories.push(r.category);
		next.category_rules = [...next.category_rules.filter((x) => x.merchant_key !== r.merchant_key), { merchant_key: r.merchant_key, category: r.category }];
	}
	if (untrusted) {
		if (edits.add_own_names.length) refused("own_names_untrusted");
		if (edits.notes_append?.trim()) refused("notes_untrusted");
		return next;
	}
	for (const n of edits.add_own_names) if (!next.own_names.includes(n)) next.own_names.push(n);
	if (edits.notes_append?.trim()) next.judgement_notes = `${next.judgement_notes}${next.judgement_notes ? "\n" : ""}${edits.notes_append.trim()}`;
	return next;
}

async function context(t: Tick, e: Esc): Promise<string> {
	// The reason can quote an email (an error, a model's words): fenced too.
	const head = `<escalation id="${e.id}" kind="${e.kind}" opened="${e.created_at}">\n${fence("reason", e.reason)}`;
	// An uploaded statement (ref "upload:…") is no email: nothing to fetch from Gmail.
	if (e.kind === "unknown_format" && e.ref_id && !isUploadId(e.ref_id) && t.svc.gmail && !t.gmailStopped) {
		try {
			return `${head}\n${emailPrompt(await t.svc.gmail.message(e.ref_id))}\n</escalation>`;
		} catch (err) {
			t.gmailFailure(err);
		}
	}
	if (e.kind === "month_failed" && e.ref_id) {
		const st = await t.db.prepare("SELECT account_id, period_start, period_end, opening_balance_minor, closing_balance_minor, recon_detail_json FROM statements WHERE id = ?").bind(e.ref_id).first();
		if (st) return `${head}\nStatement: ${JSON.stringify(st)}\n</escalation>`;
	}
	return `${head}\n</escalation>`;
}

export const escalations: Step = {
	name: "escalate",
	async run(t) {
		const today = t.today();
		const prev = t.get<EscState>("escalate");
		const state: EscState = prev?.day === today ? prev : { day: today, sent: 0, asked: prev?.asked ?? [], checked_at: prev?.checked_at ?? "" };
		if (state.sent >= ESCALATIONS_PER_DAY) return;
		if (state.checked_at && t.now().getTime() - new Date(state.checked_at).getTime() < CHECK_EVERY_MS) return;
		if (!t.modelReady(t.env.LEDGER_MODEL_SENIOR) || !t.room(30)) return;
		const open = (
			await t.db
				.prepare(`SELECT id, kind, ref_id, reason, created_at FROM escalations WHERE status = 'open' AND kind NOT IN (${NOT_FOR_THE_MODEL.map(() => "?").join(", ")}) AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT ?`)
				.bind(...NOT_FOR_THE_MODEL, JSON.stringify(state.asked), ESCALATIONS_PER_DAY - state.sent)
				.all<Esc>()
		).results;
		state.checked_at = t.iso();
		if (!open.length) {
			t.putLater("escalate", state);
			return;
		}
		const parts: string[] = [];
		for (const e of open) parts.push(await context(t, e));
		// Subscription mode: the question is these escalations (their context may
		// be reworded while it waits); a newer set replaces an unanswered older one.
		const r = await readWith(t, "senior", "escalation", parts.join("\n\n"), EscalationSchema, 16000, { slot: `esc:${open.map((e) => e.id).sort().join(",")}`, group: "escalation" });
		if (!r.ok) {
			t.putLater("escalate", state);
			return;
		}
		const ids = new Set(open.map((e) => e.id));
		let version: number | null = null;
		const head = await t.head();
		const untrusted = open.some((e) => !ENGINE_ONLY.has(e.kind));
		if (r.data.playbook_edits) {
			const next = constrainToList(applyEdits(head?.body ?? emptyPlaybook(), r.data.playbook_edits, t.banks(), untrusted, (what) => t.count(`escalation_edit_refused_${what}`)), tickCategories(t));
			if (!validatePlaybook(next).length) {
				const pub = await publishPlaybook(t.db, next, head?.version ?? null, "senior", `escalations of ${today}`, t.iso());
				if (pub.ok) version = pub.version;
				t.forgetHead();
			} else t.count("escalation_edits_invalid");
		}
		const now = t.iso();
		const notes = t.get<NoteForOwner[]>("notes_for_owner") ?? [];
		const statements = [];
		for (const res of r.data.resolutions) {
			if (!ids.has(res.id)) continue;
			const esc = open.find((e) => e.id === res.id)!;
			if (res.action === "note_for_owner") {
				const note = plainNote(res.note);
				if (note) notes.push({ escalation_id: res.id, note, at: now, ...(untrusted ? { unverified: true } : {}) });
				continue;
			}
			statements.push(t.db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = ?, resolved_by_version = ? WHERE id = ? AND status = 'open'").bind(now, version, res.id));
			if (res.action === "reprocess" && esc.ref_id)
				statements.push(t.db.prepare("UPDATE work SET stage = 'new', attempts = 0, not_before = NULL, payload_json = NULL, error = NULL, updated_at = ? WHERE gmail_id = ? AND stage IN ('failed', 'done') AND gmail_id NOT LIKE 'upload:%'").bind(now, esc.ref_id));
			t.count(`escalation_${res.action}`);
		}
		state.sent += open.length;
		state.asked = [...state.asked, ...open.map((e) => e.id)].slice(-500);
		statements.push(t.put("escalate", state), t.put("notes_for_owner", notes.slice(-50)));
		await t.db.batch(statements);
	},
};
