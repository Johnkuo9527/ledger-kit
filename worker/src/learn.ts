/// Teaching the playbook to read a bank's alerts for free.
///
/// Every alert the senior model reads from a sender with no pattern leaves its
/// reading in `alert_samples` (figures only). Once a sender has three, the
/// senior model writes a pattern from those emails; it is kept ONLY if, run
/// by the engine's own `applyAlertPattern`, it reproduces every sample's
/// amount, currency, card, date and merchant exactly. Three tries per sender,
/// then the model keeps reading that sender's alerts.

import { domainOf } from "./banks";
import { emailAddress } from "../../src/dedup";
import { parsePrinted } from "../../src/money";
import { applyAlertPattern, emptyPlaybook, type AlertPattern } from "../../src/playbook";
import { publishPlaybook } from "../../src/playbook-store";
import { readWith } from "./pipeline";
import { readingWaits } from "./reader";
import { emailPrompt, senderMatches } from "./read";
import { PatternSchema, type AlertAnswer } from "./schemas";
import type { Mail } from "./gmail";
import type { Step, Tick } from "./tick";

export const SAMPLES_NEEDED = 3;
export const MAX_LEARN_ATTEMPTS = 3;
const MAX_SAMPLES = 6;

type Sample = Omit<AlertAnswer, "note" | "confidence"> & { subject: string; received_date: string };

/// Does the pattern read every sample exactly as the senior model did?
export function reproduces(p: AlertPattern, samples: readonly { mail: Mail; reading: Sample }[]): boolean {
	for (const { mail, reading } of samples) {
		let got;
		try {
			got = applyAlertPattern([p], { from: emailAddress(mail.from), subject: mail.subject, body: mail.text, received_date: reading.received_date });
		} catch {
			return false;
		}
		if (!got) return false;
		const currency = reading.currency.toUpperCase();
		let amount: number;
		try {
			amount = Math.abs(parsePrinted(reading.amount, currency)) * (reading.direction === "in" ? -1 : 1);
		} catch {
			return false;
		}
		const norm = (s: string | null) => (s ?? "").trim().toUpperCase();
		if (got.currency !== currency || got.amount_minor !== amount || got.txn_date !== reading.date || (got.last4 ?? null) !== (reading.last4 ?? null) || norm(got.merchant_raw) !== norm(reading.merchant)) return false;
	}
	return true;
}

async function learnOne(t: Tick, sender: string): Promise<void> {
	const attempts = t.get<Record<string, number>>("learn_attempts") ?? {};
	const prior = attempts[sender] ?? 0;
	// Subscription mode: each attempt is its own question (a rejected pattern is
	// asked for afresh, as a new API call would be), and while the reader has
	// not answered, nothing is fetched from Gmail and no attempt is counted.
	const slot = `${sender}#${prior + 1}`;
	if (t.subscription && (await readingWaits(t, "senior", "pattern", slot))) return;
	t.putLater("learn_attempts", { ...attempts, [sender]: prior + 1 });
	const rows = (await t.db.prepare("SELECT gmail_id, reading_json FROM alert_samples WHERE sender = ? ORDER BY created_at DESC LIMIT ?").bind(sender, MAX_SAMPLES).all<{ gmail_id: string; reading_json: string }>()).results;
	const samples: { mail: Mail; reading: Sample }[] = [];
	for (const r of rows) {
		try {
			samples.push({ mail: await t.svc.gmail!.message(r.gmail_id), reading: JSON.parse(r.reading_json) as Sample });
		} catch (e) {
			t.gmailFailure(e);
			return;
		}
	}
	const user = samples.map((s, i) => `Sample ${i + 1}:\n${emailPrompt(s.mail)}\nYour reading: ${JSON.stringify(s.reading)}`).join("\n\n");
	const r = await readWith(t, "senior", "pattern", `${user}\n\nWrite one pattern for sender ${sender} that reproduces all ${samples.length} readings.`, PatternSchema, 8000, { slot });
	if (!r.ok) {
		if (r.why === "blocked" && r.pending) t.putLater("learn_attempts", { ...attempts, [sender]: prior });
		return;
	}
	const head = await t.head();
	const book = head?.body ?? emptyPlaybook();
	// The pattern belongs to the bank whose domain sent the samples (the owner's
	// list), never to what the model called it: every alert it reads lands there.
	const listed = t.banks().bankOfDomain(domainOf(sender));
	const institution = listed ?? (samples[0]!.reading.institution === "other" ? "other" : samples[0]!.reading.institution);
	const p: AlertPattern = {
		id: `learned-${sender}-${book.alert_patterns.length + 1}`,
		institution,
		from: sender,
		...(r.data.subject ? { subject: r.data.subject } : {}),
		body: r.data.body,
		kind_hint: r.data.kind_hint,
		default_currency: r.data.default_currency.toUpperCase(),
		date_format: r.data.date_format,
		...(r.data.credit ? { credit: true } : {}),
	};
	if (!reproduces(p, samples)) {
		t.count("pattern_rejected");
		return;
	}
	const next = {
		...book,
		alert_patterns: [...book.alert_patterns, p],
		senders: { ...book.senders, alerts: book.senders.alerts.some((s) => senderMatches(s.from, sender)) ? book.senders.alerts : [...book.senders.alerts, { institution, from: sender }] },
	};
	const pub = await publishPlaybook(t.db, next, head?.version ?? null, "senior", `learned an alert pattern for ${sender} from ${samples.length} samples`, t.iso());
	t.forgetHead();
	t.count(pub.ok ? "pattern_learned" : "pattern_not_published");
}

export const learnPatterns: Step = {
	name: "learn",
	async run(t) {
		if (!t.svc.gmail || t.gmailStopped || !t.modelReady(t.env.LEDGER_MODEL_SENIOR) || !t.room(30)) return;
		const senders = (await t.db.prepare("SELECT sender FROM alert_samples GROUP BY sender HAVING COUNT(*) >= ?").bind(SAMPLES_NEEDED).all<{ sender: string }>()).results;
		if (!senders.length) return;
		const head = await t.head();
		const attempts = t.get<Record<string, number>>("learn_attempts") ?? {};
		const todo = senders.find((s) => (attempts[s.sender] ?? 0) < MAX_LEARN_ATTEMPTS && !(head?.body.alert_patterns ?? []).some((p) => senderMatches(p.from, s.sender)));
		if (todo) await learnOne(t, todo.sender);
	},
};
