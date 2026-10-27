/// The daily upkeep: once a day (the owner's day, LEDGER_TIMEZONE), after the
/// queue has drained (or from 12:00 regardless), in five resumable pieces —
/// a tick that runs short carries on with the next piece next minute.
///
///   taps       Apple Pay taps held for an unknown Wallet card, tried again
///   receipts   receipts still waiting for their card line (60 days), again
///   months     escalated months checked again (the owner or the senior model may
///              have fixed lines since)
///   subs       subscriptions detected over two years of purchases; the owner's
///              own word (ignored / cancelled) is never overwritten
///   trips      trips proposed from flight and hotel receipts; a trip the owner
///              confirmed, dismissed or edited is his and never moved

import { addDays } from "../../src/dates";
import { fillCardCounters, ingestEvidence, lookBackPayments, lookBackRules, recheckStatement, retryHeldTaps, undoAmountMatches, type EvidenceIn } from "../../src/engine";
import { detectSubscriptions, ownerSubscription, type Cadence, type SubLine } from "../../src/subscriptions";
import { planProposals, proposeTrips, type ExistingTrip, type TravelEvidence } from "../../src/trips";
import type { Evidence, EvidenceDetails } from "../../src/types";
import { engineFor } from "./pipeline";
import { ONE_BILL_BANKS } from "./read";
import type { Step, Tick } from "./tick";

export const UPKEEP_PIECES = ["taps", "receipts", "months", "subs", "trips"] as const;
type Piece = (typeof UPKEEP_PIECES)[number] | "done";
export const UPKEEP_HOUR = 12;
const HELD_RECEIPT_DAYS = 60;
const PIECE_COST: Record<Exclude<Piece, "done">, number> = { taps: 120, receipts: 200, months: 100, subs: 12, trips: 12 };

interface UpkeepState {
	day: string;
	piece: Piece;
}

async function taps(t: Tick): Promise<void> {
	const r = await retryHeldTaps(engineFor(t, await t.head(), "rules"), { limit: 10 });
	t.count("upkeep_taps", r.filter((x) => x.status !== "held").length);
}

async function receipts(t: Tick): Promise<void> {
	const since = addDays(t.today(), -HELD_RECEIPT_DAYS);
	const held = (await t.db.prepare("SELECT * FROM evidence WHERE type = 'receipt' AND line_id IS NULL AND txn_date >= ? ORDER BY txn_date LIMIT 20").bind(since).all<Evidence>()).results;
	const e = engineFor(t, await t.head(), "rules");
	let matched = 0;
	for (const ev of held) {
		if (!t.room(12)) break;
		const again: EvidenceIn = {
			type: "receipt",
			message_id: ev.message_id,
			fingerprint: ev.fingerprint,
			txn_date: ev.txn_date,
			currency: ev.currency,
			amount_minor: ev.amount_minor,
			merchant_raw: ev.merchant_raw,
			kind_hint: ev.kind_hint as EvidenceIn["kind_hint"],
			details: ev.details_json ? (JSON.parse(ev.details_json) as EvidenceDetails) : undefined,
		};
		const r = await ingestEvidence(e, again);
		if (r.status === "attached" || r.status === "created") matched++;
	}
	t.count("upkeep_receipts", matched);
}

async function months(t: Tick): Promise<void> {
	const ids = (await t.db.prepare("SELECT id FROM statements WHERE recon_status = 'escalated' ORDER BY period_end DESC LIMIT 3").bind().all<{ id: string }>()).results;
	const e = engineFor(t, await t.head(), "rules");
	for (const { id } of ids) {
		if (!t.room(40)) break;
		const r = await recheckStatement(e, id);
		if (r?.ok) t.count("upkeep_months_fixed");
	}
}

async function subs(t: Tick): Promise<void> {
	const today = t.today();
	const lines = (
		await t.db
			.prepare("SELECT id, kind, state, txn_date, merchant_key, merchant_name, orig_currency, orig_minor FROM lines WHERE kind = 'purchase' AND state <> 'void' AND txn_date >= ?")
			.bind(addDays(today, -731))
			.all<SubLine>()
	).results;
	// The owner's word teaches detection (meeting point B): a merchant he set aside
	// is never proposed again, and one he marked himself is his — detection
	// adds no other cadence for it, and only keeps his row's figures current.
	const owner = (
		await t.db.prepare("SELECT merchant_key, currency, cadence, owner_status, marked_by FROM subscriptions WHERE owner_status = 'ignored' OR marked_by = 'owner'").bind().all<{ merchant_key: string; currency: string; cadence: Cadence; owner_status: string | null; marked_by: string | null }>()
	).results;
	const marked = owner.filter((r) => r.marked_by === "owner" && r.owner_status !== "ignored");
	const skip = new Set([...owner.filter((r) => r.owner_status === "ignored").map((r) => r.merchant_key), ...marked.map((r) => r.merchant_key)]);
	const own = marked.flatMap((r) => {
		const sub = ownerSubscription(lines.filter((l) => l.merchant_key === r.merchant_key && l.orig_currency === r.currency), r.cadence, today);
		return sub ? [{ ...sub, cadence: r.cadence }] : [];
	});
	const found = [...detectSubscriptions(lines, today).filter((s) => !skip.has(s.merchant_key)), ...own].map((s) => ({ ...s, id: t.deps.newId() }));
	const now = t.iso();
	const statements = [];
	for (let i = 0; i < found.length; i += 200) {
		statements.push(
			t.db
				.prepare(
					"INSERT INTO subscriptions (id, merchant_key, merchant_name, currency, cadence, amount_minor, previous_amount_minor, price_changed_on, first_seen, last_charged, next_renewal, occurrences, status, owner_status, line_ids_json, updated_at, detected_at) " +
						"SELECT json_extract(value, '$.id'), json_extract(value, '$.merchant_key'), json_extract(value, '$.merchant_name'), json_extract(value, '$.currency'), json_extract(value, '$.cadence'), " +
						"json_extract(value, '$.amount_minor'), json_extract(value, '$.previous_amount_minor'), json_extract(value, '$.price_changed_on'), json_extract(value, '$.first_seen'), " +
						"json_extract(value, '$.last_charged'), json_extract(value, '$.next_renewal'), json_extract(value, '$.occurrences'), json_extract(value, '$.status'), NULL, " +
						"json_extract(value, '$.line_ids'), ?, ? FROM json_each(?) WHERE true " +
						"ON CONFLICT (merchant_key, currency, cadence) DO UPDATE SET merchant_name = excluded.merchant_name, amount_minor = excluded.amount_minor, " +
						"previous_amount_minor = excluded.previous_amount_minor, price_changed_on = excluded.price_changed_on, first_seen = excluded.first_seen, " +
						"last_charged = excluded.last_charged, next_renewal = excluded.next_renewal, occurrences = excluded.occurrences, status = excluded.status, " +
						"line_ids_json = excluded.line_ids_json, updated_at = excluded.updated_at",
				)
				.bind(now, now, JSON.stringify(found.slice(i, i + 200))),
		);
	}
	if (statements.length) await t.db.batch(statements);
	t.count("upkeep_subscriptions", found.length);
}

async function trips(t: Tick): Promise<void> {
	const rows = (
		await t.db
			.prepare("SELECT id, line_id, details_json FROM evidence WHERE type = 'receipt' AND json_extract(details_json, '$.travel') IS NOT NULL AND txn_date >= ?")
			.bind(addDays(t.today(), -731))
			.all<{ id: string; line_id: string | null; details_json: string }>()
	).results;
	const travel: TravelEvidence[] = rows.flatMap((r) => {
		const d = JSON.parse(r.details_json) as EvidenceDetails;
		const flights = d.travel?.flights ?? [];
		const hotels = d.travel?.hotels ?? [];
		return flights.length || hotels.length ? [{ evidence_id: r.id, line_id: r.line_id, flights, hotels }] : [];
	});
	if (!travel.length) return;
	const existing = (
		await t.db.prepare("SELECT id, status, start_date, end_date, owner_edited_at FROM trips").bind().all<ExistingTrip & { owner_edited_at: string | null }>()
	).results.map((x) => ({ ...x, status: x.status === "proposed" && x.owner_edited_at ? ("confirmed" as const) : x.status }));
	const plan = planProposals(proposeTrips(travel), existing);
	const now = t.iso();
	const statements = [
		...plan.create.map((p) =>
			t.db
				.prepare("INSERT INTO trips (id, name, destination, countries_json, start_date, end_date, status, evidence_ids_json, confirmed_at, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, 'proposed', ?, NULL, ?, ?)")
				.bind(t.deps.newId(), p.destination, JSON.stringify(p.countries), p.start_date, p.end_date, JSON.stringify(p.evidence_ids), now, now),
		),
		...plan.refresh.map(({ trip_id, proposal: p }) =>
			t.db
				.prepare("UPDATE trips SET destination = ?, countries_json = ?, start_date = ?, end_date = ?, evidence_ids_json = ?, updated_at = ? WHERE id = ? AND status = 'proposed' AND owner_edited_at IS NULL")
				.bind(p.destination, JSON.stringify(p.countries), p.start_date, p.end_date, JSON.stringify(p.evidence_ids), now, trip_id),
		),
	];
	if (statements.length && t.room(statements.length + 2)) await t.db.batch(statements);
	t.count("upkeep_trips_proposed", plan.create.length);
}

const RUN: Record<Exclude<Piece, "done">, (t: Tick) => Promise<void>> = { taps, receipts, months, subs, trips };

export const upkeep: Step = {
	name: "upkeep",
	async run(t) {
		const today = t.today();
		let state = t.get<UpkeepState>("upkeep");
		if (state?.day === today && state.piece === "done") return;
		if (!state || state.day !== today) {
			if (t.localHour() < UPKEEP_HOUR) {
				const busy = await t.db.prepare("SELECT 1 AS x FROM work WHERE stage IN ('new', 'ingest') AND (not_before IS NULL OR not_before <= ?) LIMIT 1").bind(t.iso()).first();
				if (busy) return;
			}
			state = { day: today, piece: UPKEEP_PIECES[0] };
		}
		while (state.piece !== "done") {
			const piece: Exclude<Piece, "done"> = state.piece;
			if (!t.room(PIECE_COST[piece])) break;
			await RUN[piece](t);
			const i = UPKEEP_PIECES.indexOf(piece);
			state = { day: today, piece: UPKEEP_PIECES[i + 1] ?? "done" };
			t.putLater("upkeep", state);
		}
	},
};

/// The look back (round 2, ask 7): lines already in the ledger read again
/// under rules added since they were filed, a few each tick until done, then
/// never again until LOOK_BACK_VERSION changes. Every change is logged in
/// line_events by the engine; nothing is deleted. Pieces:
///   undo      bank lines made card payments by amount alone under the old
///             rule, checked under today's; one it would not make is undone
///             and its card line matched afresh (v4, the 25 Jun fix)
///   payments  bank lines → card_payment (the owner's rule), paired with the card leg
///   rules     every line under the owner's payee rules (kind and category; v2;
///             v3: transfer lines only)
///   days      each card's cut-off day from its newest statement, unless the owner
///             set it (v3, meeting point C)
///   reread    statements read before round 2, queued to be read once more
///             (one model call each, at most REREAD_MAX): every 台新 bill, so
///             it splits onto each card, and each card's newest bill, for its
///             minimum due, due date and payments (v3, meeting point D / ask 4)
///   resplit   every bill of a bank that sends one bill for all its cards
///             (台新) whose lines sit on at most one card still in use (never
///             split, or split only onto the lost card) is read once more, newest first (at most REREAD_MAX), so its lines
///             reach the card they were charged on (v5, 14 Oct 2026: live, card
///             5506 had no lines; nothing stored keeps a printed line's card,
///             so only a new reading can split it)
/// A ledger that finished an earlier version runs only what is new: from v3,
/// undo then payments (under the new amount rule) and done — never the
/// statement reread again; from v4, only resplit.
export const LOOK_BACK_VERSION = 5;
/// Lines per page of the "undo" piece, and a page's ceiling (per line: its
/// card leg, two checks of the owner's word, its candidates, two undos, a fresh match).
export const LOOK_BACK_UNDO_PAGE = 1;
const LOOK_BACK_UNDO_COST = 24 * LOOK_BACK_UNDO_PAGE + 4;
/// Lines per page of the "rules" piece: one read, a look at the owner's own edits, and a few writes.
export const LOOK_BACK_RULES_PAGE = 100;
const LOOK_BACK_RULES_COST = 13;
export const LOOK_BACK_PAGE = 5;
/// A page's ceiling: per line one change, one look for its leg, two pairings.
const LOOK_BACK_PAGE_COST = 6 * LOOK_BACK_PAGE + 4;
/// The most statements the look back sends to be read again (each is one model call).
export const REREAD_MAX = 40;

export interface LookBackState {
	version: number;
	piece: "undo" | "payments" | "rules" | "days" | "reread" | "resplit" | "done";
	cursor: string | null;
	changed: number;
	/// Where the payments piece leads: "done" for a ledger that already finished v3.
	after_payments?: "rules" | "resplit" | "done";
}

/// Each card's cut-off day (and due day, when a bill printed it) from its
/// newest statement — its own or a lost card's it replaced — unless the owner set them.
async function cardDays(t: Tick): Promise<void> {
	const newest = "(SELECT s.%s FROM statements s JOIN accounts a2 ON a2.id = s.account_id WHERE a2.id = accounts.id OR a2.replaced_by = accounts.id ORDER BY s.period_end DESC LIMIT 1)";
	await t.db
		.prepare(
			`UPDATE accounts SET statement_day = CAST(substr(${newest.replace("%s", "period_end")}, 9, 2) AS INTEGER), ` +
				`due_day = COALESCE(CAST(substr(${newest.replace("%s", "due_date")}, 9, 2) AS INTEGER), due_day), settings_source = 'statement' ` +
				`WHERE kind = 'credit_card' AND settings_source IS NULL AND ${newest.replace("%s", "period_end")} IS NOT NULL`,
		)
		.bind()
		.run();
}

/// Statements read before round 2 (no bill_group), sent to be read once more.
/// Waits while statements are still being imported (a backfill in progress).
async function reread(t: Tick): Promise<boolean> {
	const busy = await t.db.prepare("SELECT 1 AS x FROM work WHERE kind = 'statement' AND stage IN ('parked', 'ingest') LIMIT 1").bind().first();
	if (busy) return false;
	const rows = (
		await t.db
			.prepare(
				"SELECT DISTINCT s.message_id AS id FROM statements s JOIN accounts a ON a.id = s.account_id " +
					"WHERE s.bill_group IS NULL AND s.message_id IS NOT NULL AND s.message_id NOT LIKE 'upload:%' AND a.kind = 'credit_card' AND (a.institution = 'taishin' " +
					"OR s.period_end = (SELECT MAX(s2.period_end) FROM statements s2 JOIN accounts a2 ON a2.id = s2.account_id WHERE a2.id = a.id OR a2.id = a.replaced_by OR a2.replaced_by = a.id)) " +
					"ORDER BY s.period_end DESC LIMIT ?",
			)
			.bind(REREAD_MAX)
			.all<{ id: string }>()
	).results;
	if (rows.length) {
		await t.db
			.prepare("UPDATE work SET stage = 'new', attempts = 0, not_before = NULL, error = NULL, payload_json = '{\"reread\":true}', updated_at = ? WHERE stage = 'done' AND gmail_id IN (SELECT value FROM json_each(?))")
			.bind(t.iso(), JSON.stringify(rows.map((r) => r.id)))
			.run();
	}
	t.count("look_back_reread_queued", rows.length);
	return true;
}

/// One-bill banks' bills whose lines sit on at most one card in use (never
/// split, or split only onto a lost card), sent to be read once more. Waits,
/// like reread, while statements are being imported.
async function resplit(t: Tick): Promise<boolean> {
	const busy = await t.db.prepare("SELECT 1 AS x FROM work WHERE kind = 'statement' AND stage IN ('parked', 'ingest') LIMIT 1").bind().first();
	if (busy) return false;
	const banks = [...ONE_BILL_BANKS];
	const rows = (
		await t.db
			.prepare(
				"SELECT s.message_id AS id FROM statements s JOIN accounts a ON a.id = s.account_id " +
					"WHERE s.message_id IS NOT NULL AND s.message_id NOT LIKE 'upload:%' AND a.kind = 'credit_card' AND a.institution IN (SELECT value FROM json_each(?)) " +
					"GROUP BY s.message_id HAVING COUNT(DISTINCT CASE WHEN a.active = 1 AND EXISTS (SELECT 1 FROM lines l WHERE l.statement_id = s.id) THEN s.account_id END) <= 1 " +
					"ORDER BY MAX(s.period_end) DESC LIMIT ?",
			)
			.bind(JSON.stringify(banks), REREAD_MAX)
			.all<{ id: string }>()
	).results;
	if (rows.length) {
		await t.db
			.prepare("UPDATE work SET stage = 'new', attempts = 0, not_before = NULL, error = NULL, payload_json = '{\"reread\":true}', updated_at = ? WHERE stage = 'done' AND gmail_id IN (SELECT value FROM json_each(?))")
			.bind(t.iso(), JSON.stringify(rows.map((r) => r.id)))
			.run();
	}
	t.count("look_back_resplit_queued", rows.length);
	return true;
}

export const lookBack: Step = {
	name: "look_back",
	async run(t) {
		let state = t.get<LookBackState>("look_back");
		// An earlier version finished: v3 re-runs the rules (transfer lines only) and adds days + reread;
		// v4 undoes amount-only matches the new rule would not make, then pairs again.
		if (state && state.version < 3 && state.piece === "done") state = { version: LOOK_BACK_VERSION, piece: "undo", cursor: null, changed: state.changed, after_payments: "rules" };
		if (state && state.version === 3 && state.piece === "done") state = { version: LOOK_BACK_VERSION, piece: "undo", cursor: null, changed: state.changed, after_payments: "resplit" };
		// v5 adds only the one-bill resplit.
		if (state && state.version === 4) state = { ...state, version: LOOK_BACK_VERSION, piece: state.piece === "done" ? "resplit" : state.piece, ...(state.after_payments === "done" ? { after_payments: "resplit" as const } : {}) };
		if (!state || state.version !== LOOK_BACK_VERSION) state = { version: LOOK_BACK_VERSION, piece: "undo", cursor: null, changed: 0 };
		if (state.piece === "done") return;
		const e = engineFor(t, await t.head(), "rules");
		while (state.piece === "undo" && t.room(LOOK_BACK_UNDO_COST)) {
			const r = await undoAmountMatches(e, state.cursor, LOOK_BACK_UNDO_PAGE);
			state = { ...state, cursor: r.next, changed: state.changed + r.changed, piece: r.next === null ? "payments" : "undo" };
			t.count("look_back_changed", r.changed);
			t.count("look_back_undone", r.changed);
			t.putLater("look_back", state);
		}
		while (state.piece === "payments" && t.room(LOOK_BACK_PAGE_COST)) {
			const r = await lookBackPayments(e, state.cursor, LOOK_BACK_PAGE);
			state = { ...state, cursor: r.next, changed: state.changed + r.changed, piece: r.next === null ? (state.after_payments ?? "rules") : "payments" };
			t.count("look_back_changed", r.changed);
			t.putLater("look_back", state);
		}
		while (state.piece === "rules" && t.room(LOOK_BACK_RULES_COST)) {
			const r = await lookBackRules(e, state.cursor, LOOK_BACK_RULES_PAGE);
			state = { ...state, cursor: r.next, changed: state.changed + r.changed, piece: r.next === null ? "days" : "rules" };
			t.count("look_back_changed", r.changed);
			t.putLater("look_back", state);
		}
		if (state.piece === "days" && t.room(4)) {
			await cardDays(t);
			state = { ...state, cursor: null, piece: "reread" };
			t.putLater("look_back", state);
		}
		if (state.piece === "reread" && t.room(6) && (await reread(t))) {
			state = { ...state, piece: "resplit" };
			t.putLater("look_back", state);
		}
		if (state.piece === "resplit" && t.room(6) && (await resplit(t))) {
			state = { ...state, piece: "done" };
			t.putLater("look_back", state);
		}
	},
};

/// One-time (14 Oct 2026): bank card bills that name one of the owner's
/// credit cards but were filed without it as their counter account get it
/// (engine.ts fillCardCounters), so 繳款 counts them. Runs until nothing is
/// left, then never again while CARD_COUNTERS_VERSION stays the same. The owner's
/// own pairing is never changed.
export const CARD_COUNTERS_VERSION = 1;
const CARD_COUNTERS_PAGE = 20;

export const cardCounters: Step = {
	name: "card_counters",
	async run(t) {
		if (t.get<number>("card_counters") === CARD_COUNTERS_VERSION) return;
		if (!t.room(4 + 2 * CARD_COUNTERS_PAGE)) return;
		const r = await fillCardCounters(engineFor(t, null, "rules"), CARD_COUNTERS_PAGE); // no playbook needed: digits only
		t.count("card_counters_filled", r.changed);
		if (!r.more) t.putLater("card_counters", CARD_COUNTERS_VERSION);
	},
};
