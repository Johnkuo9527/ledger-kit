/// The rules, applied to the database. the daily engine's daily run and the connector's tools call
/// these; nothing else writes ledger lines.
///
///   ingestEvidence  — a bank alert, an Apple Pay tap, a receipt
///   ingestStatement — a card or bank statement and its lines: confirms FX,
///                     attaches overseas fees, learns markups, sets the flags,
///                     reconciles the month
///   addCash / correctHome / setReimbursable / addReimburseRange — the owner's edits
///
/// Every change to a line writes a line_events row in the SAME batch.

import { homeCurrency } from "./home";
import { say } from "./words";
import { addDays, daysBetween, isIsoDate } from "./dates";
import { insertRow, placeholders, updateById, type Bound, type Db } from "./db";
import { manualFingerprint, statementLineFingerprint } from "./dedup";
import { parseTap, walletKey } from "./shortcut";
import { estimateBill, marketRate, markupFor, observe, homeView, shouldLearn, type LearnedMarkup, type RateLookup } from "./fx";
import { transition, type LineEvent } from "./lifecycle";
import { candidateFits, feeTarget, matchEvidence, MATCH_WINDOW_DAYS, STRONG_MERCHANT, type Candidate, type MatchInput, type StatementRow } from "./matching";
import { merchantDisplay, merchantKey, type MerchantAlias } from "./merchant";
import { formatMoney } from "./money";
import { ownerSubscription, type Cadence, type SubLine } from "./subscriptions";
import { isTransferLine, OWNER_KINDS, kindUnder, ruleChanges, ruleFor, ruleForLine, type OwnerKind, type PayeeRule } from "./payees";
import { billCheck, type BillLine } from "./bills";
import { isMissedByAlerts, isNotOnStatement, reconcileStatement, reconStatusFor, statementAccountId, WALLET_LAG_DAYS, type ReconResult } from "./reconcile";
import { fitsTopUpRule, GRAB, MAX_BONUS_RATIO, toldOnly, isDirectGrabCharge, isWallet, namesGrab, offsetMerchant, offsetNote, planCosts, planOffsets, creditText, dealCredit, dealText, topUpNote, walletOf, walletStates, type WalletAccount } from "./wallet";
import { findRefundOriginal, REFUND_WINDOW_DAYS } from "./refunds";
import { Refused } from "./refused";
import { CARD_PAYMENT_WINDOW_DAYS, cardPaymentTarget, classifyKind, decideCardPaymentByAmount, findTransferPair, paidCard, TRANSFER_WINDOW_DAYS, withCardCounter } from "./transfers";
import { canMoveTrip, type TripStatus } from "./trips";
import type { Account, Actor, Evidence, EvidenceDetails, EvidenceType, KindHint, LineKind, LineRow, Statement } from "./types";

export interface Engine {
	db: Db;
	now: () => string; // new Date().toISOString()
	newId: () => string; // crypto.randomUUID()
	ownNames: readonly string[]; // from the playbook
	aliases: readonly MerchantAlias[]; // from the playbook
	actor: Actor; // who is acting: 'rules' in the daily run, 'owner' from a tool
}

// ------------------------------------------------------------------ reading

export async function loadAccounts(db: Db): Promise<Account[]> {
	return (await db.prepare("SELECT * FROM accounts").bind().all<Account>()).results;
}

export async function getLine(db: Db, id: string): Promise<LineRow | null> {
	return db.prepare("SELECT * FROM lines WHERE id = ?").bind(id).first<LineRow>();
}

/// The accounts whose lines a statement of `statementAccount` carries.
function statementGroup(accounts: readonly Account[], statementAccount: string): Set<string> {
	return new Set(accounts.filter((a) => statementAccountId(a) === statementAccount).map((a) => a.id));
}

async function rateLookup(db: Db, date: string): Promise<RateLookup> {
	const rows = (
		await db
			.prepare("SELECT date, currency, quote, rate FROM fx_rates WHERE date BETWEEN ? AND ?")
			.bind(addDays(date, -7), date)
			.all<{ date: string; currency: string; quote: string; rate: number }>()
	).results;
	const map = new Map(rows.map((r) => [`${r.date}|${r.currency}|${r.quote}`, r.rate]));
	return (d, c, q) => map.get(`${d}|${c}|${q}`);
}

async function markupDefaults(db: Db): Promise<Map<string, number>> {
	const rows = (await db.prepare("SELECT institution, markup FROM fx_markup_defaults").bind().all<{ institution: string; markup: number }>()).results;
	return new Map(rows.map((r) => [r.institution, r.markup]));
}

async function learnedMarkup(db: Db, accountId: string, currency: string): Promise<LearnedMarkup | undefined> {
	return (
		(await db
			.prepare("SELECT markup, observed_txn_date FROM card_fx_markups WHERE account_id = ? AND currency = ?")
			.bind(accountId, currency)
			.first<LearnedMarkup>()) ?? undefined
	);
}

/// Evidence types per line, for lines matching `where`. A JOIN, never a long
/// IN (…) list: D1 refuses more than 100 bound values in one statement, and a
/// receipt's candidates span every account.
async function evidenceTypesWhere(db: Db, where: string, args: unknown[]): Promise<Map<string, Set<EvidenceType>>> {
	const rows = (
		await db
			.prepare(`SELECT ev.line_id, ev.type FROM evidence ev JOIN lines l ON l.id = ev.line_id WHERE ${where}`)
			.bind(...args)
			.all<{ line_id: string; type: EvidenceType }>()
	).results;
	const out = new Map<string, Set<EvidenceType>>();
	for (const r of rows) (out.get(r.line_id) ?? out.set(r.line_id, new Set()).get(r.line_id)!).add(r.type);
	return out;
}

async function candidatesNear(db: Db, accountIds: ReadonlySet<string> | null, date: string): Promise<Candidate[]> {
	const ids = accountIds ? [...accountIds] : [];
	const where = "l.state <> 'void' AND l.txn_date BETWEEN ? AND ?" + (accountIds ? ` AND l.account_id IN (${placeholders(ids.length)})` : "");
	const args = [addDays(date, -MATCH_WINDOW_DAYS), addDays(date, MATCH_WINDOW_DAYS), ...ids];
	const lines = (await db.prepare(`SELECT l.* FROM lines l WHERE ${where}`).bind(...args).all<LineRow>()).results;
	const types = await evidenceTypesWhere(db, where, args);
	return lines.map((line) => ({ line, has: types.get(line.id) ?? new Set() }));
}

// ------------------------------------------------------------------ writing

function lineEvent(db: Db, lineId: string, at: string, actor: Actor, event: string, before: unknown, after: unknown): Bound {
	return db
		.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(lineId, at, actor, event, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after));
}

/// UPDATE a line and record what changed, in one batch. Exported for the connector's
/// edit tools: every edit to a line goes through here, never a bare UPDATE.
export async function changeLine(e: Engine, line: LineRow, changes: Partial<LineRow>, event: string, extra: Bound[] = []): Promise<LineRow> {
	const before: Partial<LineRow> = {};
	const after: Partial<LineRow> = {};
	for (const [k, v] of Object.entries(changes) as [keyof LineRow, unknown][]) {
		if (line[k] !== v) {
			(before as Record<string, unknown>)[k] = line[k];
			(after as Record<string, unknown>)[k] = v;
		}
	}
	if (Object.keys(after).length === 0 && extra.length === 0) return line;
	const at = e.now();
	const stmts = [...extra];
	if (Object.keys(after).length) {
		// The SGD figure the owner set by hand is his. The rules write it only while
		// home_set_by is still 'rules' — checked in the UPDATE itself, so a
		// correction landing between our read and this write survives.
		const home: Record<string, unknown> = {};
		const rest: Record<string, unknown> = { updated_at: at };
		for (const [k, v] of Object.entries(after)) (HOME_COLUMNS.has(k) && e.actor !== "owner" ? home : rest)[k] = v;
		stmts.unshift(updateById(e.db, "lines", line.id, rest), lineEvent(e.db, line.id, at, e.actor, event, before, after));
		if (Object.keys(home).length) {
			const cols = Object.keys(home);
			stmts.splice(1, 0, e.db.prepare(`UPDATE lines SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND home_set_by = 'rules'`).bind(...Object.values(home), line.id));
		}
	}
	await e.db.batch(stmts);
	return { ...line, ...after, updated_at: at };
}

const HOME_COLUMNS: ReadonlySet<string> = new Set(["home_minor", "home_status", "home_rate", "home_set_by"]);

function move(line: LineRow, event: LineEvent): LineRow["state"] {
	return transition(line.state, event, line.statement_id !== null);
}

/// Hand a case up to the senior model. Re-running a held item never files
/// the same case twice while the first is still open.
export async function escalate(e: Engine, kind: string, refId: string | null, reason: string): Promise<void> {
	await escalateStmt(e, kind, refId, reason).run();
}

export function escalateStmt(e: Engine, kind: string, refId: string | null, reason: string): Bound {
	return e.db
		.prepare(
			"INSERT INTO escalations (id, kind, ref_id, reason, status, resolved_by_version, created_at, resolved_at) " +
				"SELECT ?, ?, ?, ?, 'open', NULL, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM escalations WHERE kind = ? AND ref_id IS ? AND status = 'open')",
		)
		.bind(e.newId(), kind, refId, reason, e.now(), kind, refId);
}

/// Many lines, the SAME columns, in two statements however many lines there
/// are: the line_events rows, then one UPDATE … FROM json_each. For the
/// statement import's flag and reconcile passes, which touch every line of a
/// month and would otherwise cost two queries per line. Lines with nothing to
/// change are left out; the events read exactly as changeLine writes them.
/// Never for the home-currency columns (changeLine guards the owner's own figure).
function bulkChange(e: Engine, event: string, at: string, items: readonly { line: LineRow; changes: Partial<LineRow> }[]): Bound[] {
	const rows: { id: string; before: string; after: string; v: Partial<LineRow> }[] = [];
	let cols: string[] | null = null;
	for (const { line, changes } of items) {
		const keys = Object.keys(changes).sort();
		if (keys.some((k) => HOME_COLUMNS.has(k))) throw new Error("bulkChange never writes the home-currency columns");
		if (cols && cols.join() !== keys.join()) throw new Error("bulkChange needs the same columns for every line");
		cols = keys;
		const before: Record<string, unknown> = {};
		const after: Record<string, unknown> = {};
		for (const k of keys as (keyof LineRow)[]) {
			if (line[k] !== changes[k]) {
				before[k] = line[k];
				after[k] = changes[k];
			}
		}
		if (Object.keys(after).length) rows.push({ id: line.id, before: JSON.stringify(before), after: JSON.stringify(after), v: changes });
	}
	if (!rows.length || !cols) return [];
	const payload = JSON.stringify(rows);
	return [
		e.db
			.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) SELECT json_extract(value, '$.id'), ?, ?, ?, json_extract(value, '$.before'), json_extract(value, '$.after') FROM json_each(?)")
			.bind(at, e.actor, event, payload),
		e.db
			.prepare(`UPDATE lines SET ${cols.map((c) => `${c} = json_extract(j.value, '$.v.${c}')`).join(", ")}, updated_at = ? FROM json_each(?) AS j WHERE lines.id = json_extract(j.value, '$.id')`)
			.bind(at, payload),
	];
}

// ------------------------------------------------------------ building a line

/// The home-currency figure of a line, unless the owner has set it himself.
async function withHome(e: Engine, line: LineRow): Promise<LineRow> {
	if (line.home_set_by === "owner") return line;
	if (line.bill_currency === homeCurrency()) return { ...line, ...homeView(line.bill_minor, line.bill_currency, line.bill_status, null) };
	const found = marketRate(await rateLookup(e.db, line.txn_date), line.txn_date, line.bill_currency, homeCurrency());
	return { ...line, ...homeView(line.bill_minor, line.bill_currency, line.bill_status, found?.rate ?? null), flag_no_rate: found ? line.flag_no_rate : ownerOk(line, "no_rate") ? 0 : 1 };
}

/// Did the owner already look at this flag on this line and say it is fine (migration 0007)?
export function ownerOk(line: Pick<LineRow, "owner_ok">, flag: string): boolean {
	return (line.owner_ok ?? "").split(",").includes(flag);
}

interface LineSource {
	txn_date: string;
	post_date?: string | null;
	currency: string;
	amount_minor: number;
	bill_currency?: string | null;
	bill_minor?: number | null;
	merchant_raw: string | null;
	merchant_country?: string | null;
}

async function buildLine(e: Engine, account: Account, kind: LineKind, src: LineSource, over: Partial<LineRow>): Promise<LineRow> {
	const now = e.now();
	const key = merchantKey(src.merchant_raw, e.aliases);
	// Cash is held in whatever currency it is; every other account bills in its own.
	const billCcy = account.kind === "cash" ? src.currency : account.currency;
	let line: LineRow = {
		id: e.newId(),
		account_id: account.id,
		kind,
		state: "open",
		txn_date: src.txn_date,
		post_date: src.post_date ?? null,
		merchant_raw: src.merchant_raw,
		merchant_key: key || null,
		merchant_name: key ? merchantDisplay(key) : null,
		merchant_country: src.merchant_country ?? null,
		category: null,
		orig_currency: src.currency,
		orig_minor: src.amount_minor,
		bill_currency: billCcy,
		bill_minor: src.amount_minor,
		bill_status: "exact",
		fee_minor: 0,
		market_rate: null,
		markup: null,
		markup_source: null,
		effective_rate: null,
		observed_markup: null,
		home_minor: 0,
		home_status: "exact",
		home_rate: null,
		home_set_by: "rules",
		statement_id: null,
		refund_of: null,
		transfer_group: null,
		merged_into: null,
		reimbursable_override: null,
		flag_missed_by_alerts: 0,
		flag_not_on_statement: 0,
		flag_unlinked_refund: 0,
		income_offset: null,
		offset_account_id: null,
		flag_no_rate: 0,
		note: null,
		created_by: e.actor,
		created_at: now,
		updated_at: now,
		counter_account_id: null,
		offset_of: null,
		...over,
	};
	if (src.currency !== billCcy) {
		const found = marketRate(await rateLookup(e.db, src.txn_date), src.txn_date, src.currency, billCcy);
		if (src.bill_minor !== null && src.bill_minor !== undefined && src.bill_currency === billCcy) {
			// A statement that prints both amounts: confirmed on arrival.
			line = { ...line, bill_minor: src.bill_minor, bill_status: "confirmed", market_rate: found?.rate ?? null };
		} else if (found) {
			const m = markupFor(await learnedMarkup(e.db, account.id, src.currency), account.institution, await markupDefaults(e.db));
			line = {
				...line,
				market_rate: found.rate,
				markup: m.markup,
				markup_source: m.source,
				bill_minor: estimateBill(src.amount_minor, src.currency, billCcy, found.rate, m.markup),
				bill_status: "estimate",
			};
		} else {
			// No rate within a week: say so, never invent one.
			line = { ...line, bill_minor: 0, bill_status: "estimate", flag_no_rate: 1, state: "review" };
		}
	}
	return withHome(e, line);
}

// ---------------------------------------------------------- alerts and taps

export interface EvidenceIn {
	type: "alert" | "apple_pay_shortcut" | "receipt";
	/// The account, when the caller already knows it (a tap's Wallet name).
	account_id?: string | null;
	/// A bank alert Gmail vouched for (DMARC/DKIM pass at the bank's own
	/// domain). Only such an alert may teach a card its number.
	authenticated?: boolean;
	institution?: string | null;
	last4?: string | null;
	message_id?: string | null;
	fingerprint: string;
	txn_date: string;
	txn_time?: string | null;
	currency: string;
	amount_minor: number;
	merchant_raw: string | null;
	merchant_country?: string | null;
	kind_hint?: KindHint | null;
	details?: EvidenceDetails;
	/// The category the source itself tells (a Grab e-receipt: a ride, a food
	/// order); used only when the line is made from this evidence and no rule of
	/// The owner's gives one. Never moves an existing line.
	category?: string | null;
}

export type IngestResult =
	| { status: "duplicate" }
	| { status: "attached" | "created"; line_id: string; evidence_id: string }
	| { status: "held"; evidence_id: string; reason: string };

function findAccount(accounts: readonly Account[], ev: Pick<EvidenceIn, "account_id" | "institution" | "last4">): Account | null {
	if (ev.account_id) return accounts.find((a) => a.id === ev.account_id) ?? null;
	if (!ev.last4) return null;
	const hits = accounts.filter((a) => a.last4 === ev.last4 && (!ev.institution || a.institution === ev.institution));
	return hits.length === 1 ? hits[0]! : null;
}

/// A card whose number the owner did not have (the DBS debit card): the first card
/// alert from that bank naming a number no account has teaches it — but only
/// when exactly ONE card at that bank is still unnumbered, so it can never be
/// pinned on the wrong card, and only from a card purchase or refund alert (a
/// transfer alert may name some other account), and only from an alert Gmail
/// vouched for as the bank's own mail (anyone can email the owner a "bank alert").
/// Logged as a resolved escalation, for the record.
async function learnCardNumber(e: Engine, accounts: readonly Account[], ev: Pick<EvidenceIn, "institution" | "last4" | "authenticated">): Promise<Account | null> {
	if (ev.authenticated !== true) return null;
	if (!ev.institution || !ev.last4 || !/^\d{4}$/.test(ev.last4)) return null;
	if (accounts.some((a) => a.last4 === ev.last4 && a.institution === ev.institution)) return null;
	const open = accounts.filter((a) => a.institution === ev.institution && a.last4 === null && (a.kind === "debit_card" || a.kind === "credit_card"));
	if (open.length !== 1) return null;
	const card = open[0]!;
	const now = e.now();
	const [changed] = await e.db.batch([
		e.db.prepare("UPDATE accounts SET last4 = ? WHERE id = ? AND last4 IS NULL").bind(ev.last4, card.id),
		insertRow(e.db, "escalations", {
			id: e.newId(),
			kind: "learned_card_number",
			ref_id: card.id,
			reason: `${card.name} learned its last 4 digits from a bank alert`,
			status: "resolved",
			resolved_by_version: null,
			created_at: now,
			resolved_at: now,
		}),
	]);
	return changed!.meta.changes === 1 ? { ...card, last4: ev.last4 } : null;
}

export async function ingestEvidence(e: Engine, ev: EvidenceIn): Promise<IngestResult> {
	const accounts = await loadAccounts(e.db);
	const account =
		ev.type === "receipt" ? null : (findAccount(accounts, ev) ?? (ev.type === "alert" && (ev.kind_hint === "purchase" || ev.kind_hint === "refund") ? await learnCardNumber(e, accounts, ev) : null));
	const row: Evidence = {
		id: e.newId(),
		type: ev.type,
		line_id: null,
		message_id: ev.message_id ?? null,
		statement_id: null,
		fingerprint: ev.fingerprint,
		institution: ev.institution ?? account?.institution ?? null,
		last4: ev.last4 ?? account?.last4 ?? null,
		txn_date: ev.txn_date,
		txn_time: ev.txn_time ?? null,
		post_date: null,
		currency: ev.currency,
		amount_minor: ev.amount_minor,
		bill_currency: null,
		bill_minor: null,
		merchant_raw: ev.merchant_raw,
		merchant_country: ev.merchant_country ?? null,
		kind_hint: ev.kind_hint ?? null,
		details_json: ev.details ? JSON.stringify(ev.details) : null,
		created_at: e.now(),
	};
	const stored = await ensureEvidence(e.db, row);
	// Already part of a line: a re-sent email. Held, or cut off half-way by a
	// crash: take it up again under its existing id.
	if (stored.line_id) return { status: "duplicate" };
	row.id = stored.id;

	if (ev.type !== "receipt" && !account) {
		await escalate(e, "unknown_account", row.id, `no single account for ${ev.institution ?? "?"} ending ${ev.last4 ?? "?"}`);
		return { status: "held", evidence_id: row.id, reason: "which account this is could not be told" };
	}
	const rule = ruleForLine(merchantKey(ev.merchant_raw, e.aliases), ev.type !== "receipt" && isTransferLine(account?.kind, ev.merchant_raw, ev.kind_hint), await payeeRules(e));
	const ruled = withPayeeRule(
		ev.type === "receipt"
			? { kind: (ev.amount_minor < 0 ? "refund" : "purchase") as LineKind, counter_account_id: null, review: false }
			: classifyKind({ kind_hint: ev.kind_hint ?? null, merchant_raw: ev.merchant_raw, amount_minor: ev.amount_minor, details: ev.details ?? {}, txn_date: ev.txn_date }, account!, accounts, e.ownNames),
		ev.amount_minor,
		rule,
	);
	// A card bill made so by the owner's payee rule still names the card it paid.
	const kindResult = account ? withCardCounter(ruled, account, ev.merchant_raw, accounts) : ruled;

	const input: MatchInput = {
		type: ev.type,
		account_ids: account ? new Set([account.id]) : null,
		kind: kindResult.kind,
		currency: ev.currency,
		amount_minor: ev.amount_minor,
		txn_date: ev.txn_date,
		merchant_key: merchantKey(ev.merchant_raw, e.aliases),
	};
	const decision = matchEvidence(input, await candidatesNear(e.db, input.account_ids, ev.txn_date));

	if (decision.action === "attach") {
		const at = e.now();
		await e.db.batch([
			e.db.prepare("UPDATE evidence SET line_id = ? WHERE id = ?").bind(decision.line_id, row.id),
			lineEvent(e.db, decision.line_id, at, e.actor, "evidence", null, { evidence_id: row.id, type: ev.type }),
		]);
		return { status: "attached", line_id: decision.line_id, evidence_id: row.id };
	}
	if (decision.action === "hold") return { status: "held", evidence_id: row.id, reason: decision.reason };
	if (decision.action === "review") {
		await escalate(e, "match_ambiguous", row.id, `${decision.reason}: ${decision.candidate_ids.join(", ")}`);
		return { status: "held", evidence_id: row.id, reason: decision.reason };
	}

	let line = await buildLine(e, account!, kindResult.kind, { ...ev, merchant_country: ev.merchant_country ?? null }, {
		counter_account_id: kindResult.counter_account_id,
		...(ev.category && (kindResult.kind === "purchase" || kindResult.kind === "refund") ? { category: ev.category } : {}),
		...ruleCategory(kindResult.kind, rule),
	});
	if (kindResult.review) line = { ...line, state: "review" };
	await e.db.batch([
		insertRow(e.db, "lines", line),
		e.db.prepare("UPDATE evidence SET line_id = ? WHERE id = ?").bind(line.id, row.id),
		lineEvent(e.db, line.id, line.created_at, e.actor, "create", null, { evidence_id: row.id, type: ev.type }),
	]);
	if (kindResult.review) await escalate(e, "line_unsure", line.id, "looks like a card bill at an issuer not on the account list");
	await afterCreate(e, line, kindResult.counter_account_id, accounts);
	await absorbHandLine(e, line, accounts);
	return { status: "created", line_id: line.id, evidence_id: row.id };
}

/// Insert evidence unless the same fact is already stored; either way return
/// the stored row's id and line. Makes every import safe to re-run.
async function ensureEvidence(db: Db, row: Evidence): Promise<{ id: string; line_id: string | null }> {
	const inserted = await insertRow(db, "evidence", row, true).run();
	if (inserted.meta.changes === 1) return { id: row.id, line_id: null };
	const existing = await db.prepare("SELECT id, line_id FROM evidence WHERE type = ? AND fingerprint = ?").bind(row.type, row.fingerprint).first<{ id: string; line_id: string | null }>();
	if (!existing) throw new Error("evidence vanished between insert and read");
	return existing;
}

/// Taps held because their Wallet card name was unknown, tried again — run
/// after the owner adds Wallet names to the account list.
///
/// `walletKey` retries only that card's taps; `limit` caps how many in one go
/// (oldest first). Each retry costs about ten D1 queries, and Cloudflare's free
/// plan allows 50 per request: the rest wait for the next call, never lost.
export async function retryHeldTaps(e: Engine, opts: { walletKey?: string; limit?: number } = {}): Promise<IngestResult[]> {
	const where = "type = 'apple_pay_shortcut' AND line_id IS NULL" + (opts.walletKey ? " AND json_extract(details_json, '$.wallet_key') = ?" : "");
	const args: unknown[] = opts.walletKey ? [opts.walletKey] : [];
	const held = (
		await e.db
			.prepare(`SELECT * FROM evidence WHERE ${where} ORDER BY created_at, id${opts.limit ? " LIMIT ?" : ""}`)
			.bind(...args, ...(opts.limit ? [opts.limit] : []))
			.all<Evidence>()
	).results;
	const out: IngestResult[] = [];
	for (const ev of held) {
		const key = (JSON.parse(ev.details_json ?? "{}") as { wallet_key?: string }).wallet_key;
		if (!key) continue;
		const hit = await e.db.prepare("SELECT account_id FROM account_wallet_names WHERE wallet_key = ?").bind(key).first<{ account_id: string }>();
		if (!hit) continue;
		const r = await ingestEvidence(e, {
			type: "apple_pay_shortcut",
			account_id: hit.account_id,
			fingerprint: ev.fingerprint,
			txn_date: ev.txn_date,
			txn_time: ev.txn_time,
			currency: ev.currency,
			amount_minor: ev.amount_minor,
			merchant_raw: ev.merchant_raw,
			kind_hint: "purchase",
		});
		if (r.status === "created" || r.status === "attached") {
			await e.db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = ? WHERE kind = 'unknown_wallet_card' AND ref_id = ? AND status = 'open'").bind(e.now(), ev.id).run();
		}
		out.push(r);
	}
	return out;
}

/// One Apple Pay tap from the shortcut (the endpoint's whole job after the key
/// check). An unknown Wallet card name is held and escalated, never guessed.
export async function ingestTap(e: Engine, body: unknown): Promise<IngestResult | { status: "refused"; message: string }> {
	const tap = parseTap(body);
	if (typeof tap === "string") return { status: "refused", message: tap };
	const hit = await e.db.prepare("SELECT account_id FROM account_wallet_names WHERE wallet_key = ?").bind(tap.wallet_key).first<{ account_id: string }>();
	if (!hit) {
		const id = e.newId();
		const ins = await insertRow(
			e.db,
			"evidence",
			{
				id,
				type: "apple_pay_shortcut",
				line_id: null,
				fingerprint: tap.fingerprint,
				txn_date: tap.txn_date,
				txn_time: tap.txn_time,
				currency: tap.currency,
				amount_minor: tap.amount_minor,
				merchant_raw: tap.merchant_raw,
				kind_hint: "purchase",
				details_json: JSON.stringify({ wallet_key: tap.wallet_key }),
				created_at: e.now(),
			},
			true,
		).run();
		if (ins.meta.changes === 0) return { status: "duplicate" };
		await escalate(e, "unknown_wallet_card", id, `Apple Wallet card "${tap.wallet_key}" is not on the account list`);
		return { status: "held", evidence_id: id, reason: "this Wallet card name is not on the account list yet" };
	}
	return ingestEvidence(e, {
		type: "apple_pay_shortcut",
		account_id: hit.account_id,
		fingerprint: tap.fingerprint,
		txn_date: tap.txn_date,
		txn_time: tap.txn_time,
		currency: tap.currency,
		amount_minor: tap.amount_minor,
		merchant_raw: tap.merchant_raw,
		kind_hint: "purchase",
	});
}

/// What a new line sets in motion: a refund finds its purchase, a transfer
/// finds its other leg, a receipt that arrived first finds its payment.
async function afterCreate(e: Engine, line: LineRow, counterAccountId: string | null, accounts: readonly Account[]): Promise<void> {
	if (line.kind === "refund") await linkRefund(e, line);
	await pairPayment(e, line, counterAccountId, accounts);
	await walletAfterCreate(e, line, accounts);
	const orphans = (
		await e.db
			.prepare("SELECT * FROM evidence WHERE type = 'receipt' AND line_id IS NULL AND txn_date BETWEEN ? AND ?")
			.bind(addDays(line.txn_date, -MATCH_WINDOW_DAYS), addDays(line.txn_date, MATCH_WINDOW_DAYS))
			.all<Evidence>()
	).results;
	for (const r of orphans) {
		const input: MatchInput = {
			type: "receipt",
			account_ids: null,
			kind: r.amount_minor < 0 ? "refund" : "purchase",
			currency: r.currency,
			amount_minor: r.amount_minor,
			txn_date: r.txn_date,
			merchant_key: merchantKey(r.merchant_raw, e.aliases),
		};
		const d = matchEvidence(input, await candidatesNear(e.db, null, r.txn_date));
		if (d.action === "attach") await e.db.prepare("UPDATE evidence SET line_id = ? WHERE id = ? AND line_id IS NULL").bind(d.line_id, r.id).run();
	}
}

/// A DBS payment the owner wrote down by hand as CASH because the bank's email had
/// not come (15 Oct 2026: a S$2.50 PayNow he recorded as
/// 「飲料（DBS PayNow）」) is the same money as the DBS line that arrives later —
/// from the alert, or from the statement. So when a new DBS line (money out, in
/// SGD) is made, ONE hand-made cash line of exactly that amount, on the same
/// day, whose merchant or note names PayNow / PayLah / DBS / POSB, joins it:
/// the cash line is voided with merged_into = the DBS line (its evidence moves
/// along), and the DBS line takes the owner's category — his word, so no later rule
/// moves it. Only a DBS line that is spending (a PayNow to someone else is a
/// purchase, transfers.ts classifyKind): never a payee the owner said is something
/// else (a friend, a loan), never his own money moving (a transfer to one of
/// his accounts or to his own name, a card bill), never a cash line that does
/// not say it was really DBS money (cash he did spend that day stays).
const HAND_DBS = /PayNow|PayLah|\bDBS\b|\bPOSB\b/i;
export async function absorbHandLine(e: Engine, created: LineRow, accounts: readonly Account[]): Promise<LineRow | null> {
	if (accounts.find((a) => a.id === created.account_id)?.institution !== "dbs") return null;
	if (created.orig_currency !== "SGD" || created.orig_minor <= 0 || created.kind !== "purchase") return null;
	const cash = accounts.filter((a) => a.kind === "cash").map((a) => a.id);
	if (!cash.length) return null;
	const hand = (
		await e.db
			.prepare(
				`SELECT * FROM lines WHERE account_id IN (${placeholders(cash.length)}) AND created_by = 'owner' AND state <> 'void' AND merged_into IS NULL ` +
					"AND txn_date = ? AND orig_currency = 'SGD' AND orig_minor = ? ORDER BY created_at, id",
			)
			.bind(...cash, created.txn_date, created.orig_minor)
			.all<LineRow>()
	).results.find((l) => HAND_DBS.test(`${l.merchant_raw ?? ""} ${l.merchant_name ?? ""} ${l.note ?? ""}`));
	if (!hand) return null;
	const line = await getLine(e.db, created.id);
	// Own money moving (a transfer to one of his accounts, a card bill) is never the spending he wrote down.
	if (!line || line.state === "void" || line.merged_into || line.transfer_group !== null || line.counter_account_id !== null) return null;
	const changes: Partial<LineRow> = {};
	if (hand.category) changes.category = hand.category;
	if (hand.reimbursable_override !== null && line.reimbursable_override === null) changes.reimbursable_override = hand.reimbursable_override;
	const at = e.now();
	const handAfter = { state: move(hand, "void"), merged_into: line.id };
	return changeLine({ ...e, actor: "owner" }, line, changes, "category", [
		updateById(e.db, "lines", hand.id, { ...handAfter, updated_at: at }),
		lineEvent(e.db, hand.id, at, e.actor, "merged", { state: hand.state, merged_into: null }, { ...handAfter, why: "the DBS line of this payment arrived" }),
		e.db.prepare("UPDATE evidence SET line_id = ? WHERE line_id = ?").bind(line.id, hand.id),
	]);
}

/// A transfer / card payment finds its other leg (same size, opposite sign,
/// ±3 days). The owner's rule by amount: a card's "payment received" with no leg
/// finds the bank line of exactly that amount (±5 days) — and a bank line read
/// as a payment to someone finds the card payment it really was; that bank line
/// becomes a card_payment (logged "card_payment_by_amount"). By amount alone the
/// choice is always made from the card's side, over EVERY bank line that could
/// be its leg (decideCardPaymentByAmount: never a payee that reads as a person,
/// no payee before bank words, then the nearest; equally good = the card's line
/// goes to 待確認 for the owner to pick). A bank line whose kind the owner set is never
/// one of them. Exported for the upkeep's look back over old lines. Answers the
/// line as it now stands.
export async function pairPayment(e: Engine, line: LineRow, counterAccountId: string | null, accounts: readonly Account[]): Promise<LineRow> {
	const banks = new Set(accounts.filter((a) => a.kind === "bank").map((a) => a.id));
	const isBankOut = line.kind === "purchase" && line.bill_minor > 0 && banks.has(line.account_id);
	if (line.state === "void" || line.transfer_group !== null || (line.kind !== "transfer" && line.kind !== "card_payment" && !isBankOut)) return line;
	// The owner said what money to this payee is: never re-read by amount.
	const rules = await payeeRules(e);
	const bankRule = (l: LineRow) => ruleForLine(l.merchant_key, isTransferLine("bank", l.merchant_raw, l.kind), rules)?.kind;
	if (isBankOut && bankRule(line)) return line;
	const w = Math.max(3, CARD_PAYMENT_WINDOW_DAYS);
	const near = (
		await e.db
			.prepare("SELECT * FROM lines WHERE state <> 'void' AND account_id <> ? AND transfer_group IS NULL AND txn_date BETWEEN ? AND ?")
			.bind(line.account_id, addDays(line.txn_date, -w), addDays(line.txn_date, w))
			.all<LineRow>()
	).results.filter((c) => !(c.kind === "purchase" && banks.has(c.account_id) && bankRule(c)));
	const pair = isBankOut ? null : findTransferPair(line, counterAccountId, near);
	if (pair) return (await groupPair(e, line, pair))[0];
	if (!isBankOut && !(line.kind === "card_payment" && line.bill_minor < 0)) return line;

	let card = line;
	let bankLines = near;
	if (isBankOut) {
		const found = decideCardPaymentByAmount(line, banks, near).pick;
		if (!found) return line;
		card = found;
		bankLines = (await bankOutNear(e, card, w)).filter((c) => !bankRule(c));
	}
	// The owner said none of the transfers the ledger offered paid it: never by amount again.
	if (ownerOk(card, PAYMENT_PICK)) return line;
	const owners = await ownerKindIds(e.db, bankLines.filter((c) => c.kind === "purchase" && banks.has(c.account_id)).map((c) => c.id));
	const d = decideCardPaymentByAmount(card, banks, bankLines.filter((c) => !owners.has(c.id)));
	if (d.tied.length) {
		const asked = await askWhichPayment(e, card);
		return card.id === line.id ? asked : line;
	}
	if (!d.pick) return line;
	const bank = await changeLine(e, d.pick, { kind: "card_payment", counter_account_id: card.account_id }, "card_payment_by_amount");
	// Waiting in 待確認 only for its leg (askWhichPayment), and now found: out of review.
	if (card.state === "review" && (await e.db.prepare("SELECT 1 AS x FROM line_events WHERE line_id = ? AND event = 'payment_pick_needed' LIMIT 1").bind(card.id).first())) {
		card = await changeLine(e, card, { state: move(card, "resolve") }, "payment_pick_found");
	}
	const [b, c] = await groupPair(e, bank, card);
	return b.id === line.id ? b : c.id === line.id ? c : line;
}

/// Two legs of one movement of the owner's money: one transfer group.
async function groupPair(e: Engine, self: LineRow, pair: LineRow): Promise<[LineRow, LineRow]> {
	const group = e.newId();
	const a = await changeLine(e, self, { transfer_group: group, ...(self.counter_account_id ? {} : { counter_account_id: pair.account_id }) }, "pair_transfer");
	const b = await changeLine(e, pair, { transfer_group: group, ...(pair.counter_account_id ? {} : { counter_account_id: self.account_id }) }, "pair_transfer");
	return [a, b];
}

/// Money out of his bank accounts of exactly this card payment's amount,
/// within `days`, not yet paired: what could be its other leg.
async function bankOutNear(e: Engine, card: LineRow, days: number): Promise<LineRow[]> {
	return (
		await e.db
			.prepare(
				"SELECT * FROM lines WHERE state <> 'void' AND transfer_group IS NULL AND kind = 'purchase' AND bill_currency = ? AND bill_minor = ? AND txn_date BETWEEN ? AND ? " +
					"AND account_id IN (SELECT id FROM accounts WHERE kind = 'bank')",
			)
			.bind(card.bill_currency, -card.bill_minor, addDays(card.txn_date, -days), addDays(card.txn_date, days))
			.all<LineRow>()
	).results;
}

/// The lines (of these) whose kind the owner set himself.
async function ownerKindIds(db: Db, ids: readonly string[]): Promise<Set<string>> {
	if (!ids.length) return new Set();
	const rows = (
		await db
			.prepare("SELECT DISTINCT line_id FROM line_events WHERE actor = 'owner' AND after_json LIKE '%\"kind\"%' AND line_id IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify(ids))
			.all<{ line_id: string }>()
	).results;
	return new Set(rows.map((r) => r.line_id));
}

/// The owner's "never ask again" on a card payment the ledger could not pair.
export const PAYMENT_PICK = "payment_pick";

/// A card's "payment received" that two (or more) bank lines fit equally
/// well: nothing is changed; it waits in 待確認 for the owner to pick its leg
/// (reviewLine "pair") — unless he already said to leave it.
async function askWhichPayment(e: Engine, card: LineRow): Promise<LineRow> {
	if (card.state === "review" || card.state === "void" || ownerOk(card, PAYMENT_PICK)) return card;
	return changeLine(e, card, { state: move(card, "flag_review") }, "payment_pick_needed");
}

/// The look back's undo (25 Jun): every bank line the ledger made a
/// card payment by amount alone under the old rule is checked again under
/// today's (decideCardPaymentByAmount, from the card's side). One today's rule
/// would not pick goes back to what it was and comes out of its pair (logged
/// "undo_card_payment_by_amount"); the card's line is then matched afresh
/// (it may pick the right leg, or wait in 待確認). A line the owner touched — his
/// kind on the bank line, his pairing on either — is left alone. Pages by the
/// bank line's id; answers the next cursor, null when done.
export async function undoAmountMatches(e: Engine, after: string | null, limit: number): Promise<{ next: string | null; changed: number }> {
	const rows = (
		await e.db
			.prepare(
				"SELECT l.*, (SELECT v.before_json FROM line_events v WHERE v.line_id = l.id AND v.event = 'card_payment_by_amount' AND v.actor = 'rules' ORDER BY v.at DESC LIMIT 1) AS undo_json " +
					"FROM lines l WHERE l.id > ? AND l.state <> 'void' AND l.kind = 'card_payment' AND l.transfer_group IS NOT NULL " +
					"AND EXISTS (SELECT 1 FROM line_events v WHERE v.line_id = l.id AND v.event = 'card_payment_by_amount' AND v.actor = 'rules') " +
					"AND NOT EXISTS (SELECT 1 FROM line_events j WHERE j.line_id = l.id AND j.actor = 'owner') ORDER BY l.id LIMIT ?",
			)
			.bind(after ?? "", limit)
			.all<LineRow & { undo_json: string }>()
	).results;
	const next = rows.length < limit ? null : rows.at(-1)!.id;
	if (!rows.length) return { next, changed: 0 };
	const accounts = await loadAccounts(e.db);
	const banks = new Set(accounts.filter((a) => a.kind === "bank").map((a) => a.id));
	const rules = await payeeRules(e);
	let changed = 0;
	const ruled = (l: LineRow) => ruleForLine(l.merchant_key, isTransferLine("bank", l.merchant_raw, l.kind), rules)?.kind;
	for (const { undo_json, ...bank } of rows) {
		if (ruled(bank)) continue; // the owner's word on this payee
		const card = await e.db
			.prepare("SELECT * FROM lines WHERE transfer_group = ? AND id <> ? AND state <> 'void' AND kind = 'card_payment'")
			.bind(bank.transfer_group, bank.id)
			.first<LineRow>();
		if (!card || banks.has(card.account_id)) continue;
		const touched = await e.db.prepare("SELECT 1 AS x FROM line_events WHERE line_id = ? AND actor = 'owner' LIMIT 1").bind(card.id).first();
		if (touched) continue;
		const was = JSON.parse(undo_json || "{}") as Partial<LineRow>;
		const asBefore: LineRow = { ...bank, kind: was.kind ?? "purchase", transfer_group: null };
		const others = (await bankOutNear(e, card, CARD_PAYMENT_WINDOW_DAYS)).filter((c) => !ruled(c));
		const owners = await ownerKindIds(e.db, others.map((c) => c.id));
		const d = decideCardPaymentByAmount({ ...card, transfer_group: null }, banks, [asBefore, ...others.filter((c) => !owners.has(c.id))]);
		if (d.pick?.id === bank.id) continue;
		await changeLine(e, bank, { kind: asBefore.kind, counter_account_id: "counter_account_id" in was ? (was.counter_account_id ?? null) : bank.counter_account_id, transfer_group: null }, "undo_card_payment_by_amount");
		const paired = await e.db
			.prepare("SELECT before_json FROM line_events WHERE line_id = ? AND event = 'pair_transfer' AND after_json LIKE ? ORDER BY at DESC LIMIT 1")
			.bind(card.id, `%${bank.transfer_group}%`)
			.first<{ before_json: string }>();
		const cardWas = JSON.parse(paired?.before_json || "{}") as Partial<LineRow>;
		const freed = await changeLine(
			e,
			card,
			{ transfer_group: null, ...("counter_account_id" in cardWas ? { counter_account_id: cardWas.counter_account_id ?? null } : {}) },
			"undo_card_payment_by_amount",
		);
		changed++;
		await pairPayment(e, freed, freed.counter_account_id ?? null, accounts);
	}
	return { next, changed };
}

/// The look back (round 2, ask 7): bank lines already in the ledger, read
/// again under the owner's rule — money out to one of his card issuers is that
/// card's bill (logged "reclassify_card_payment"), and a bank line of exactly
/// a card payment's amount is its other leg (pairPayment). A page of `limit`
/// lines after `after` (by id); answers the next cursor, null when done. Lines
/// whose kind the owner set himself are left alone. Never deletes anything.
export async function lookBackPayments(e: Engine, after: string | null, limit: number): Promise<{ next: string | null; changed: number }> {
	const accounts = await loadAccounts(e.db);
	const rows = (
		await e.db
			.prepare(
				"SELECT * FROM lines WHERE id > ? AND state <> 'void' AND kind IN ('purchase', 'transfer') AND bill_minor > 0 AND transfer_group IS NULL " +
					"AND account_id IN (SELECT id FROM accounts WHERE kind = 'bank') " +
					"AND NOT EXISTS (SELECT 1 FROM line_events v WHERE v.line_id = lines.id AND v.actor = 'owner' AND v.after_json LIKE '%\"kind\"%') ORDER BY id LIMIT ?",
			)
			.bind(after ?? "", limit)
			.all<LineRow>()
	).results;
	let changed = 0;
	const rules = rows.length ? await payeeRules(e) : [];
	for (const row of rows) {
		let line = row;
		if (ruleForLine(line.merchant_key, isTransferLine("bank", line.merchant_raw, line.kind), rules)?.kind) continue; // the owner's word on this payee
		const target = cardPaymentTarget(line, accounts);
		if (target.card_payment) {
			line = await changeLine(e, line, { kind: "card_payment", counter_account_id: target.counter_account_id }, "reclassify_card_payment");
			changed++;
		}
		const after2 = await pairPayment(e, line, line.counter_account_id ?? null, accounts);
		if (!target.card_payment && after2.kind !== line.kind) changed++;
	}
	return { next: rows.length < limit ? null : rows.at(-1)!.id, changed };
}

/// One-time upkeep (14 Oct 2026): bank card bills that name exactly
/// one of the owner's credit cards ("Other bank's card ending 5502") but were left
/// without that card as their counter account get it now, so 繳款 counts the
/// payment. Idempotent: a line is touched only while its counter is not a
/// credit card. A line whose counter account the owner set himself (pairing it in
/// 待確認) is never changed. Logged "fill_card_counter". At most `limit`
/// lines per call; `more` = call again.
export async function fillCardCounters(e: Engine, limit = 20): Promise<{ changed: number; more: boolean }> {
	const rows = (
		await e.db
			.prepare(
				"SELECT * FROM lines WHERE state <> 'void' AND kind = 'card_payment' AND account_id IN (SELECT id FROM accounts WHERE kind IN ('bank', 'debit_card')) " +
					"AND (counter_account_id IS NULL OR counter_account_id NOT IN (SELECT id FROM accounts WHERE kind = 'credit_card')) " +
					"AND NOT EXISTS (SELECT 1 FROM line_events v WHERE v.line_id = lines.id AND v.actor = 'owner' AND v.after_json LIKE '%\"counter_account_id\"%') ORDER BY id",
			)
			.bind()
			.all<LineRow>()
	).results;
	if (!rows.length) return { changed: 0, more: false };
	const accounts = await loadAccounts(e.db);
	let changed = 0;
	for (const line of rows) {
		const card = paidCard(line, accounts);
		if (!card || card.id === line.counter_account_id) continue;
		if (changed >= limit) return { changed, more: true };
		await changeLine(e, line, { counter_account_id: card.id }, "fill_card_counter");
		changed++;
	}
	return { changed, more: false };
}

async function linkRefund(e: Engine, refund: LineRow): Promise<void> {
	const purchases = (
		await e.db
			.prepare("SELECT * FROM lines WHERE kind = 'purchase' AND state <> 'void' AND account_id = ? AND txn_date BETWEEN ? AND ?")
			.bind(refund.account_id, addDays(refund.txn_date, -REFUND_WINDOW_DAYS), refund.txn_date)
			.all<LineRow>()
	).results;
	const given = (
		await e.db
			.prepare("SELECT refund_of, -SUM(orig_minor) AS total FROM lines WHERE kind = 'refund' AND state <> 'void' AND refund_of IS NOT NULL AND id <> ? GROUP BY refund_of")
			.bind(refund.id)
			.all<{ refund_of: string; total: number }>()
	).results;
	const original = findRefundOriginal(refund, purchases, new Map(given.map((g) => [g.refund_of, g.total])));
	await changeLine(e, refund, original ? { refund_of: original.id, flag_unlinked_refund: 0 } : { flag_unlinked_refund: 1 }, "link_refund");
}

// ---------------------------------------------------------------- statements

export interface StatementIn {
	account_id: string;
	period_start: string;
	period_end: string;
	currency: string;
	opening_balance_minor: number | null;
	closing_balance_minor: number | null;
	printed_net_minor: number | null;
	message_id?: string | null;
	attachment_name?: string | null;
	/// Round 2 (D, 6.): the card bill as printed (card's currency, minor units),
	/// and the bill a split statement's pieces share. Absent = not read.
	previous_balance_minor?: number | null;
	statement_balance_minor?: number | null;
	minimum_due_minor?: number | null;
	payments_credited_minor?: number | null;
	due_date?: string | null;
	bill_group?: string | null;
	bill_primary?: 0 | 1;
}

export interface StatementLineIn {
	seq: number; // position on the statement, from 1
	txn_date: string;
	post_date?: string | null;
	currency: string; // the merchant's currency, as printed
	amount_minor: number; // + money out / debt up
	bill_currency?: string | null; // when a foreign line also prints the billed amount
	bill_minor?: number | null;
	merchant_raw: string | null;
	merchant_country?: string | null;
	kind_hint: KindHint | null; // 'fx_fee' for an itemised overseas fee
	details?: EvidenceDetails;
	/// The category the statement itself tells (a GrabPay statement: a ride, a
	/// food order); used only when this line makes a new ledger line and no rule
	/// of the owner's gives one.
	category?: string | null;
}

export type StatementResult =
	| { status: "duplicate" }
	| { status: "imported"; statement_id: string; recon: ReconResult; created: string[]; attached: string[]; held: string[] }
	/// The query budget ran low: call again with the same statement to go on.
	| { status: "partial"; statement_id: string; created: string[]; attached: string[]; held: string[] };

/// What one call may still spend, in D1 queries (worker/src/budget.ts BudgetDb).
export interface QueryBudget {
	remaining(): number;
}

/// Queries kept in hand before starting one more piece of a statement. Each
/// is a generous ceiling of what that piece costs (a printed line with its
/// refund, transfer and receipt follow-ups; one foreign confirmation with its
/// re-estimates; the closing batch). The budget wrapper's hard stop backs
/// these up: a tick cut off mid-piece is finished on the next call.
export const STATEMENT_COST = { line: 40, foreign: 25, finish: 30 } as const;

/// Import a statement and its lines. With `opts.budget` the import stops
/// BETWEEN lines when the budget runs low and answers "partial"; calling again
/// with the same statement carries on where it stopped (one query reloads
/// what is done), and the end state is the same as a one-go import.
export async function ingestStatement(e: Engine, st: StatementIn, printed: readonly StatementLineIn[], opts: { budget?: QueryBudget } = {}): Promise<StatementResult> {
	const low = (need: number) => opts.budget !== undefined && opts.budget.remaining() < need;
	const accounts = await loadAccounts(e.db);
	const account = accounts.find((a) => a.id === st.account_id);
	if (!account || (account.kind !== "credit_card" && account.kind !== "bank" && account.kind !== "wallet")) throw new Error(`no statements for account ${st.account_id}`);
	let statement: Statement = {
		id: e.newId(),
		...st,
		message_id: st.message_id ?? null,
		attachment_name: st.attachment_name ?? null,
		recon_status: "pending",
		recon_checked_at: null,
		recon_detail_json: null,
		created_at: e.now(),
	};
	let resumed = false;
	if ((await insertRow(e.db, "statements", statement, true).run()).meta.changes === 0) {
		const existing = await e.db.prepare("SELECT * FROM statements WHERE account_id = ? AND period_end = ?").bind(st.account_id, st.period_end).first<Statement>();
		// Finished before: a true duplicate. Never finished (the worker died
		// half-way, or the budget ran out): finish it now — every step below is
		// safe to repeat.
		if (!existing || existing.recon_checked_at !== null) return { status: "duplicate" };
		statement = existing;
		resumed = true;
	} else if (account.has_statements === 0) {
		// A card the ledger thought had no statements (Citi emails none) now has
		// one — the owner uploaded it: from now on its coverage, the month check and
		// "provisional" work as for every other card.
		await e.db.prepare("UPDATE accounts SET has_statements = 1 WHERE id = ? AND has_statements = 0").bind(account.id).run();
		account.has_statements = 1;
	}
	// Resuming: what is already done, in two queries, not two per line.
	const known = new Map<string, { id: string; line_id: string | null }>();
	const doneLines = new Map<string, LineRow>();
	if (resumed) {
		for (const r of (await e.db.prepare("SELECT id, fingerprint, line_id FROM evidence WHERE statement_id = ?").bind(statement.id).all<{ id: string; fingerprint: string; line_id: string | null }>()).results) known.set(r.fingerprint, r);
		for (const l of (await e.db.prepare("SELECT * FROM lines WHERE statement_id = ?").bind(statement.id).all<LineRow>()).results) doneLines.set(l.id, l);
	}

	const group = statementGroup(accounts, account.id);
	const created: string[] = [];
	const attached: string[] = [];
	const held: string[] = [];
	const rows: StatementRow[] = [];
	const sorted = [...printed].sort((a, b) => a.seq - b.seq);

	const evidenceFor = (p: StatementLineIn): Evidence => ({
		id: e.newId(),
		type: "statement_line",
		line_id: null,
		message_id: statement.message_id,
		statement_id: statement.id,
		fingerprint: statementLineFingerprint(statement.id, p.seq),
		institution: account.institution,
		last4: account.last4,
		txn_date: p.txn_date,
		txn_time: null,
		post_date: p.post_date ?? null,
		currency: p.currency,
		amount_minor: p.amount_minor,
		bill_currency: p.bill_currency ?? null,
		bill_minor: p.bill_minor ?? null,
		merchant_raw: p.merchant_raw,
		merchant_country: p.merchant_country ?? null,
		kind_hint: p.kind_hint,
		details_json: JSON.stringify({ ...(p.details ?? {}), seq: p.seq }),
		created_at: e.now(),
	});

	// Pass 1 — every line that is not an overseas fee.
	const partial = (): StatementResult => ({ status: "partial", statement_id: statement.id, created, attached, held });
	for (const p of sorted.filter((x) => x.kind_hint !== "fx_fee")) {
		const done = known.get(statementLineFingerprint(statement.id, p.seq));
		if (done?.line_id) {
			rows.push({ seq: p.seq, kind_hint: p.kind_hint, txn_date: p.txn_date, line: doneLines.get(done.line_id) ?? (await getLine(e.db, done.line_id)) });
			continue;
		}
		if (low(STATEMENT_COST.line)) return partial();
		const ev = evidenceFor(p);
		const stored = await ensureEvidence(e.db, ev);
		if (stored.line_id) {
			rows.push({ seq: p.seq, kind_hint: p.kind_hint, txn_date: p.txn_date, line: await getLine(e.db, stored.line_id) });
			continue;
		}
		ev.id = stored.id;
		const rule = ruleForLine(merchantKey(p.merchant_raw, e.aliases), isTransferLine(account.kind, p.merchant_raw, p.kind_hint), await payeeRules(e));
		const kindResult = withCardCounter(
			withPayeeRule(classifyKind({ kind_hint: p.kind_hint, merchant_raw: p.merchant_raw, amount_minor: p.amount_minor, details: p.details ?? {}, txn_date: p.txn_date }, account, accounts, e.ownNames), p.amount_minor, rule),
			account,
			p.merchant_raw,
			accounts,
		);
		const input: MatchInput = {
			type: "statement_line",
			account_ids: group,
			kind: kindResult.kind,
			currency: p.currency,
			amount_minor: p.amount_minor,
			txn_date: p.txn_date,
			merchant_key: merchantKey(p.merchant_raw, e.aliases),
		};
		const decision = matchEvidence(input, await candidatesNear(e.db, group, p.txn_date));
		if (decision.action === "attach") {
			const line = (await getLine(e.db, decision.line_id))!;
			const changes: Partial<LineRow> = { statement_id: statement.id, post_date: p.post_date ?? line.post_date, state: transition(line.state, "attach_statement", true) };
			if (!line.merchant_country && p.merchant_country) changes.merchant_country = p.merchant_country;
			if (line.orig_currency !== line.bill_currency) {
				const billed = decision.via === "tolerance" ? p.amount_minor : p.bill_currency === line.bill_currency ? (p.bill_minor ?? null) : null;
				if (billed !== null) Object.assign(changes, { bill_minor: billed, bill_status: "confirmed" });
			}
			await changeLine(e, line, changes, "attach_statement", [e.db.prepare("UPDATE evidence SET line_id = ? WHERE id = ?").bind(line.id, ev.id)]);
			attached.push(line.id);
			rows.push({ seq: p.seq, kind_hint: p.kind_hint, txn_date: p.txn_date, line: (await getLine(e.db, line.id))! });
		} else if (decision.action === "create") {
			const line = await buildLine(e, account, kindResult.kind, p, {
				state: kindResult.review ? "review" : "posted",
				statement_id: statement.id,
				counter_account_id: kindResult.counter_account_id,
				flag_missed_by_alerts: account.alerts_expected,
				...(p.category && (kindResult.kind === "purchase" || kindResult.kind === "refund") ? { category: p.category } : {}),
				...ruleCategory(kindResult.kind, rule),
			});
			await e.db.batch([
				insertRow(e.db, "lines", line),
				e.db.prepare("UPDATE evidence SET line_id = ? WHERE id = ?").bind(line.id, ev.id),
				lineEvent(e.db, line.id, line.created_at, e.actor, "create", null, { evidence_id: ev.id, type: "statement_line" }),
			]);
			await afterCreate(e, line, kindResult.counter_account_id, accounts);
			await absorbHandLine(e, line, accounts);
			created.push(line.id);
			rows.push({ seq: p.seq, kind_hint: p.kind_hint, txn_date: p.txn_date, line });
		} else {
			// The month will fail reconciliation on this unmatched line and go to the senior model.
			await escalate(e, "match_ambiguous", ev.id, decision.action === "review" ? decision.reason : "statement line held");
			held.push(ev.id);
			rows.push({ seq: p.seq, kind_hint: p.kind_hint, txn_date: p.txn_date, line: null });
		}
	}

	// Pass 2 — overseas fees join their purchase, so the purchase is the true cost.
	for (const p of sorted.filter((x) => x.kind_hint === "fx_fee")) {
		if (known.get(statementLineFingerprint(statement.id, p.seq))?.line_id) continue;
		if (low(STATEMENT_COST.line)) return partial();
		const ev = evidenceFor(p);
		const stored = await ensureEvidence(e.db, ev);
		if (stored.line_id) continue; // applied before a crash, atomically with its evidence
		ev.id = stored.id;
		const target = feeTarget({ seq: p.seq, txn_date: p.txn_date, amount_minor: p.amount_minor }, rows);
		if (target) {
			const line = (await getLine(e.db, target))!;
			const withFee = { ...line, fee_minor: line.fee_minor + p.amount_minor, bill_minor: line.bill_minor + p.amount_minor };
			await changeLine(e, line, { fee_minor: withFee.fee_minor, bill_minor: withFee.bill_minor, ...(await homeOnly(e, withFee)) }, "attach_fee", [
				e.db.prepare("UPDATE evidence SET line_id = ? WHERE id = ?").bind(line.id, ev.id),
			]);
		} else {
			const line = await buildLine(e, account, "fee", p, { state: "posted", statement_id: statement.id, flag_missed_by_alerts: account.alerts_expected });
			await e.db.batch([
				insertRow(e.db, "lines", line),
				e.db.prepare("UPDATE evidence SET line_id = ? WHERE id = ?").bind(line.id, ev.id),
				lineEvent(e.db, line.id, line.created_at, e.actor, "create", null, { evidence_id: ev.id, type: "statement_line" }),
			]);
			created.push(line.id);
		}
	}

	// Pass 3 — confirm every foreign charge on this statement and learn the
	// markup, oldest first. A line confirmed here gets its effective rate, so a
	// resumed import skips it; its markup is learned in the same batch.
	const onStatement = async () => (await e.db.prepare("SELECT * FROM lines WHERE statement_id = ? AND state <> 'void'").bind(statement.id).all<LineRow>()).results;
	const foreign = (await onStatement()).filter((l) => l.orig_currency !== l.bill_currency && l.bill_status === "confirmed" && l.effective_rate === null).sort((a, b) => a.txn_date.localeCompare(b.txn_date));
	for (const line of foreign) {
		if (low(STATEMENT_COST.foreign)) return partial();
		await confirmForeign(e, line);
	}
	if (low(STATEMENT_COST.finish)) return partial();
	// Every markup this statement taught re-estimates the card's open estimates
	// in that currency (the last lesson stands, as when taught one by one).
	const taught = (
		await e.db
			.prepare("SELECT m.account_id, m.currency, m.markup FROM card_fx_markups m JOIN lines l ON l.id = m.observed_line_id WHERE l.statement_id = ?")
			.bind(statement.id)
			.all<{ account_id: string; currency: string; markup: number }>()
	).results;
	for (const t of taught) await reEstimate(e, t.account_id, t.currency, t.markup);

	const recon = await closeStatement(e, statement, account, accounts, group);
	return { status: "imported", statement_id: statement.id, recon, created, attached, held };
}

/// Pass 4 — the flags; pass 5 — reconcile the month. Worked out here, then
/// written in ONE batch with the statement's result, so a month is never
/// left half-reconciled. Also the daily upkeep's re-check of an escalated
/// month (recheckStatement), after the owner or the senior model fixed lines.
async function closeStatement(e: Engine, statement: Statement, account: Account, accounts: readonly Account[], group: ReadonlySet<string>): Promise<ReconResult> {
	const lines = (await e.db.prepare("SELECT * FROM lines WHERE statement_id = ? AND state <> 'void'").bind(statement.id).all<LineRow>()).results;
	const types = await evidenceTypesWhere(e.db, "l.statement_id = ?", [statement.id]);
	const at = e.now();
	const flagged = lines.map((l) => {
		const acct = accounts.find((a) => a.id === l.account_id)!;
		const changes = { flag_missed_by_alerts: isMissedByAlerts(acct, types.get(l.id) ?? new Set()) ? 1 : 0, flag_not_on_statement: 0 } as const;
		return { line: l, changes };
	});
	const after = flagged.map(({ line, changes }) => ({ ...line, ...changes }));
	const notOnStatement = await notOnStatementChanges(e, account.id, group, isWallet(account) ? WALLET_LAG_DAYS : undefined);
	const printedRows = (await e.db.prepare("SELECT * FROM evidence WHERE statement_id = ? AND type = 'statement_line'").bind(statement.id).all<Evidence>()).results;
	const walletBalance = isWallet(account) ? ((await walletStates(e.db, [account], statement.period_end)).get(account.id)?.balance.minor ?? null) : null;
	const recon = reconcileStatement(statement, account.kind, after, printedRows, walletBalance);
	const status = reconStatusFor(recon);
	const bill = await billAndDays(e, statement, account);
	await e.db.batch([
		...bill,
		...bulkChange(e, "flags", at, flagged),
		...bulkChange(e, "flags", at, notOnStatement),
		updateById(e.db, "statements", statement.id, { recon_status: status, recon_checked_at: at, recon_detail_json: JSON.stringify(recon) }),
		...(recon.ok
			? bulkChange(
					e,
					"reconcile",
					at,
					after.filter((l) => l.state === "posted").map((l) => ({ line: l, changes: { state: move(l, "reconcile") } })),
				)
			: [escalateStmt(e, "month_failed", statement.id, recon.problems.map((p) => p.message).join("; "))]),
	]);
	return recon;
}

/// A card statement's closing extras (round 2): the bill check of its bill
/// (src/bills.ts — for a split bill, over every piece's printed lines, written
/// on the piece that carries the figures), and the card's cut-off and due day
/// read off its newest statement unless the owner set them himself (meeting point
/// C). A lost card's successor takes the days too: they are one card.
async function billAndDays(e: Engine, statement: Statement, account: Account): Promise<Bound[]> {
	if (account.kind !== "credit_card") return [];
	const group = statement.bill_group ?? null;
	const primary = group ? await e.db.prepare("SELECT * FROM statements WHERE bill_group = ? AND bill_primary = 1").bind(group).first<Statement>() : statement;
	const out: Bound[] = [];
	if (primary) {
		const lines = (
			await e.db
				.prepare(
					"SELECT ev.currency, ev.amount_minor, ev.bill_minor, ev.kind_hint, l.kind AS line_kind FROM evidence ev LEFT JOIN lines l ON l.id = ev.line_id " +
						"WHERE ev.type = 'statement_line' AND ev.statement_id IN (SELECT id FROM statements WHERE id = ? OR (bill_group IS NOT NULL AND bill_group = ?))",
				)
				.bind(primary.id, group)
				.all<BillLine>()
		).results;
		// A one-card statement read before round 2: its balances are the bill's.
		const one = group === null;
		const check = billCheck(
			{
				currency: primary.currency,
				previous_balance_minor: primary.previous_balance_minor ?? (one ? primary.opening_balance_minor : null),
				statement_balance_minor: primary.statement_balance_minor ?? (one ? primary.closing_balance_minor : null),
				payments_credited_minor: primary.payments_credited_minor ?? null,
			},
			lines,
		);
		out.push(updateById(e.db, "statements", primary.id, { bill_check: check.status, bill_detail_json: check.detail ? JSON.stringify(check.detail) : null }));
	}
	const day = (d: string | null | undefined) => (d && isIsoDate(d) ? Number(d.slice(8, 10)) : null);
	for (const target of [account.id, account.replaced_by].filter((x): x is string => !!x)) {
		out.push(
			e.db
				.prepare(
					"UPDATE accounts SET statement_day = ?, due_day = COALESCE(?, due_day), settings_source = 'statement' " +
						"WHERE id = ? AND kind = 'credit_card' AND (settings_source IS NULL OR settings_source <> 'owner') " +
						"AND NOT EXISTS (SELECT 1 FROM statements s JOIN accounts a ON a.id = s.account_id WHERE (a.id = ? OR a.replaced_by = ?) AND s.period_end > ?)",
				)
				.bind(day(statement.period_end), day(primary?.due_date), target, target, target, statement.period_end),
		);
	}
	return out;
}

// ---------------------------------------------------- a statement read again

export interface ReadPiece {
	st: StatementIn;
	lines: StatementLineIn[];
}

/// A statement already in the ledger, read again (round 2: the look back's
/// "reread" piece) — to split a bill that covers several cards (台新) onto
/// each card, and to take the bill's figures (minimum due, due date, payments)
/// the first reading did not ask for. Nothing is deleted and no line is
/// added: each printed line of the new reading takes the stored statement
/// line of the same date, currency and amount (nearest position first) and
/// moves, with its ledger line, onto its card's statement (logged "resplit");
/// a new-reading line that matches none is left out (the month check then
/// says so). Each piece's statement is (re)opened so ingestStatement finishes
/// it as a resumed import; a stored statement of this bill that the new
/// reading has no piece for is re-closed here. Safe to run twice. Answers the
/// pieces to hand to ingestStatement (none when the stored statement and the
/// new reading do not even agree on the statement date — then nothing moves,
/// and the bill is only marked as read again).
export async function prepareReread(e: Engine, read: readonly ReadPiece[]): Promise<{ pieces: ReadPiece[]; moved: number }> {
	const accounts = await loadAccounts(e.db);
	const out: ReadPiece[] = [];
	let moved = 0;
	const groups = new Map<string, ReadPiece[]>();
	for (const p of read) {
		const g = p.st.bill_group ?? `${p.st.message_id}:${p.st.account_id}`;
		(groups.get(g) ?? groups.set(g, []).get(g)!).push(p);
	}
	for (const [group, pieces] of groups) {
		const first = pieces[0]!.st;
		const institution = accounts.find((a) => a.id === first.account_id)?.institution ?? null;
		const old = (
			await e.db
				.prepare("SELECT s.* FROM statements s JOIN accounts a ON a.id = s.account_id WHERE s.message_id IS ? AND s.attachment_name IS ? AND a.institution IS ? ORDER BY s.created_at, s.id")
				.bind(first.message_id ?? null, first.attachment_name ?? null, institution)
				.all<Statement>()
		).results;
		if (!old.length) {
			out.push(...pieces); // never imported: an ordinary import
			continue;
		}
		const sameDate = old.filter((s) => s.period_end === first.period_end);
		if (!sameDate.length) {
			await e.db.batch(old.map((s) => updateById(e.db, "statements", s.id, { bill_group: group })));
			continue;
		}
		const at = e.now();
		// One statement row per piece: the stored one for that card, else a new one.
		const stmtFor = new Map<string, Statement>();
		const writes: Bound[] = [];
		for (const p of pieces) {
			const figures = {
				period_start: p.st.period_start,
				opening_balance_minor: p.st.opening_balance_minor,
				closing_balance_minor: p.st.closing_balance_minor,
				printed_net_minor: p.st.printed_net_minor,
				previous_balance_minor: p.st.previous_balance_minor ?? null,
				statement_balance_minor: p.st.statement_balance_minor ?? null,
				minimum_due_minor: p.st.minimum_due_minor ?? null,
				payments_credited_minor: p.st.payments_credited_minor ?? null,
				due_date: p.st.due_date ?? null,
				bill_group: group,
				bill_primary: p.st.bill_primary ?? 1,
				recon_checked_at: null,
			};
			const have = sameDate.find((s) => s.account_id === p.st.account_id) ?? (await e.db.prepare("SELECT * FROM statements WHERE account_id = ? AND period_end = ?").bind(p.st.account_id, p.st.period_end).first<Statement>());
			// That card already has its own statement of that date from another email: never mixed — this piece is left out.
			if (have && (have.message_id !== (p.st.message_id ?? null) || have.attachment_name !== (p.st.attachment_name ?? null))) continue;
			if (have) {
				writes.push(updateById(e.db, "statements", have.id, figures));
				stmtFor.set(p.st.account_id, { ...have, ...figures });
			} else {
				const row: Statement = { id: e.newId(), ...p.st, message_id: p.st.message_id ?? null, attachment_name: p.st.attachment_name ?? null, recon_status: "pending", recon_detail_json: null, created_at: at, ...figures };
				writes.push(insertRow(e.db, "statements", row));
				stmtFor.set(p.st.account_id, row);
			}
		}
		const stored = [...new Map([...sameDate, ...stmtFor.values()].map((s) => [s.id, s])).values()];
		const ids = stored.map((s) => s.id);
		const evs = (await e.db.prepare(`SELECT * FROM evidence WHERE type = 'statement_line' AND statement_id IN (${placeholders(ids.length)})`).bind(...ids).all<Evidence>()).results;
		const seqOf = (ev: Evidence) => Number((JSON.parse(ev.details_json ?? "{}") as { seq?: number }).seq ?? 0);
		const taken = new Set<string>();
		const evMoves: { ev: Evidence; stmt: Statement; seq: number; account: Account }[] = [];
		const kept: ReadPiece[] = [];
		for (const p of pieces) {
			const stmt = stmtFor.get(p.st.account_id);
			if (!stmt) continue;
			const account = accounts.find((a) => a.id === p.st.account_id)!;
			const lines: StatementLineIn[] = [];
			for (const l of p.lines) {
				const best = evs
					.filter((ev) => !taken.has(ev.id) && ev.txn_date === l.txn_date && ev.currency === l.currency && ev.amount_minor === l.amount_minor)
					.sort((x, y) => Math.abs(seqOf(x) - l.seq) - Math.abs(seqOf(y) - l.seq))[0];
				if (!best) continue;
				taken.add(best.id);
				lines.push(l);
				if (best.statement_id !== stmt.id || best.fingerprint !== statementLineFingerprint(stmt.id, l.seq)) evMoves.push({ ev: best, stmt, seq: l.seq, account });
			}
			kept.push({ st: p.st, lines });
		}
		// Fingerprints are unique: park the moving ones first, then write them. A
		// stored line the new reading did not match keeps its statement, under a
		// fingerprint no new position can take.
		const finals = new Set(evMoves.map((m) => statementLineFingerprint(m.stmt.id, m.seq)));
		const blocking = evs.filter((ev) => !taken.has(ev.id) && finals.has(ev.fingerprint));
		if (evMoves.length) {
			writes.push(e.db.prepare("UPDATE evidence SET fingerprint = 'reread:' || id WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...evMoves.map((m) => m.ev.id), ...blocking.map((ev) => ev.id)])));
			for (const ev of blocking) writes.push(updateById(e.db, "evidence", ev.id, { fingerprint: `${ev.fingerprint}|unmatched|${ev.id}` }));
			for (const m of evMoves) {
				writes.push(
					updateById(e.db, "evidence", m.ev.id, {
						statement_id: m.stmt.id,
						fingerprint: statementLineFingerprint(m.stmt.id, m.seq),
						institution: m.account.institution,
						last4: m.account.last4,
						details_json: JSON.stringify({ ...(JSON.parse(m.ev.details_json ?? "{}") as object), seq: m.seq }),
					}),
				);
			}
		}
		await e.db.batch(writes);
		// The ledger lines follow their printed line onto the card's statement.
		const lineMoves = evMoves.filter((m) => m.ev.line_id && m.ev.statement_id !== m.stmt.id);
		if (lineMoves.length) {
			const lineIds = [...new Set(lineMoves.map((m) => m.ev.line_id!))];
			const rows = (await e.db.prepare(`SELECT * FROM lines WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(lineIds)).all<LineRow>()).results;
			const items = rows.flatMap((line) => {
				const m = lineMoves.find((x) => x.ev.line_id === line.id)!;
				if (line.statement_id !== m.ev.statement_id) return []; // not this statement's line (an overseas fee's purchase elsewhere)
				return [{ line, changes: { account_id: m.account.id, statement_id: m.stmt.id, state: line.state === "reconciled" ? ("posted" as const) : line.state } }];
			});
			moved += await writeChanges(e, "resplit", items);
		}
		// A stored statement of this bill the new reading has no piece for: its remaining lines, closed again.
		for (const s of sameDate.filter((x) => ![...stmtFor.values()].some((y) => y.id === x.id))) {
			const left = (await e.db.prepare("SELECT * FROM evidence WHERE type = 'statement_line' AND statement_id = ?").bind(s.id).all<Evidence>()).results;
			const net = left.reduce((sum, ev) => sum + (ev.currency === s.currency ? ev.amount_minor : (ev.bill_minor ?? 0)), 0);
			const figures = { bill_group: group, bill_primary: 0 as const, opening_balance_minor: null, closing_balance_minor: null, printed_net_minor: net };
			await updateById(e.db, "statements", s.id, figures).run();
			const account = accounts.find((a) => a.id === s.account_id)!;
			await closeStatement(e, { ...s, ...figures }, account, accounts, statementGroup(accounts, account.id));
		}
		out.push(...kept);
	}
	return { pieces: out, moved };
}

/// The owner sets a card's cut-off and payment due day (meeting point C): his word,
/// never overwritten by a statement. A field left undefined keeps what the
/// card has; both null hands the card back to its statements (read again at
/// once from its newest one).
export async function setCardDays(e: Engine, accountId: string, set: { statement_day?: number | null; due_day?: number | null }): Promise<Account> {
	const account = (await loadAccounts(e.db)).find((a) => a.id === accountId);
	if (!account) throw new Refused("no such account");
	if (account.kind !== "credit_card") throw new Refused("only a credit card has a cut-off day and a payment due day");
	for (const [k, v] of Object.entries(set)) if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= 1 && v <= 31)) throw new Refused(`${k} must be a day of the month, 1 to 31`);
	const statementDay = set.statement_day !== undefined ? set.statement_day : (account.statement_day ?? null);
	const dueDay = set.due_day !== undefined ? set.due_day : (account.due_day ?? null);
	if (statementDay === null && dueDay === null) {
		const newest = await e.db
			.prepare("SELECT s.period_end, s.due_date FROM statements s JOIN accounts a ON a.id = s.account_id WHERE a.id = ? OR a.replaced_by = ? ORDER BY s.period_end DESC LIMIT 1")
			.bind(accountId, accountId)
			.first<{ period_end: string; due_date: string | null }>();
		const day = (d: string | null | undefined) => (d ? Number(d.slice(8, 10)) : null);
		await e.db
			.prepare("UPDATE accounts SET statement_day = ?, due_day = ?, settings_source = ? WHERE id = ?")
			.bind(day(newest?.period_end), day(newest?.due_date), newest ? "statement" : null, accountId)
			.run();
	} else {
		await e.db.prepare("UPDATE accounts SET statement_day = ?, due_day = ?, settings_source = 'owner' WHERE id = ?").bind(statementDay, dueDay, accountId).run();
	}
	return (await loadAccounts(e.db)).find((a) => a.id === accountId)!;
}

// ------------------------------------------------------- 待確認: the owner's answers

export const REVIEW_ACTIONS = ["accept", "void", "link", "retry_rate", "pair"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
const OWNER_OK_FLAGS = ["not_on_statement", "unlinked_refund", "no_rate"] as const;

/// The owner answers a line waiting in 待確認 (meeting point A):
///   accept      — it is fine as it stands: out of review, and the flags it
///                 carries (not on its statement, no original found, no rate)
///                 are his "fine" — never raised on it again. With
///                 `category`, filed there too.
///   void        — not a real charge (a hold, a deposit given back): removed
///                 from every total; restorable, never deleted.
///   link        — a refund: `refund_of` is the purchase it gives back.
///   retry_rate  — a foreign line with no rate: estimated again now; refused
///                 (plainly) while there is still none.
///   pair        — a card's payment received the ledger could not pair (two
///                 bank lines fit equally): `line_id` is the bank line that
///                 paid it — that line becomes its card payment, the two are
///                 one pair. Accept instead = leave it, never asked again.
export async function reviewLine(e: Engine, lineId: string, action: ReviewAction, opts: { category?: string | null; refund_of?: string | null; line_id?: string | null } = {}): Promise<LineRow> {
	const before = await getLine(e.db, lineId);
	if (before?.kind === "wallet_offset") throw new Refused(OFFSET_REFUSED);
	const out = await reviewOne(e, lineId, action, opts);
	// A wallet's balance and offsets follow at once (a top-up removed, a purchase voided).
	await tidyWalletsOf(e, before ? [before, out] : [out]);
	return out;
}

/// What the owner is told when he tries to change an offset line by itself.
export const OFFSET_REFUSED = "that line is the ledger's own offset for wallet money already counted when it was topped up; change the purchase it belongs to instead";

async function reviewOne(e: Engine, lineId: string, action: ReviewAction, opts: { category?: string | null; refund_of?: string | null; line_id?: string | null }): Promise<LineRow> {
	const owner = { ...e, actor: "owner" as const };
	const line = await getLine(e.db, lineId);
	if (!line) throw new Refused("no such line");
	if (action === "void") {
		if (line.state === "void") return line;
		return changeLine(owner, line, { state: move(line, "void") }, "void");
	}
	if (line.state === "void") throw new Refused("that line was removed; restore it first");
	if (action === "link") {
		const target = opts.refund_of ? await getLine(e.db, opts.refund_of) : null;
		if (!target || target.state === "void" || target.bill_minor <= 0 || target.id === line.id) throw new Refused("pick the purchase this refund gives back");
		if (line.bill_minor >= 0) throw new Refused("only money coming back can be linked to a purchase");
		return changeLine(owner, line, { refund_of: target.id, flag_unlinked_refund: 0, ...okFlags(line, ["unlinked_refund"]), ...(line.state === "review" ? { state: move(line, "resolve") } : {}) }, "link_refund");
	}
	if (action === "pair") {
		const accounts = await loadAccounts(e.db);
		const bank = opts.line_id ? await getLine(e.db, opts.line_id) : null;
		if (line.kind !== "card_payment" || line.bill_minor >= 0 || accounts.find((a) => a.id === line.account_id)?.kind !== "credit_card") throw new Refused("only a card's payment received can be paired with the bank line that paid it");
		if (line.transfer_group !== null) throw new Refused("that payment is already paired");
		if (
			!bank ||
			bank.state === "void" ||
			bank.transfer_group !== null ||
			accounts.find((a) => a.id === bank.account_id)?.kind !== "bank" ||
			bank.bill_currency !== line.bill_currency ||
			bank.bill_minor !== -line.bill_minor
		)
			throw new Refused("pick the bank transfer of exactly that amount that paid this card");
		const paid = await changeLine(owner, bank, { kind: "card_payment", counter_account_id: line.account_id }, "kind");
		const card = await changeLine(owner, line, { ...okFlags(line, [PAYMENT_PICK]), ...(line.state === "review" ? { state: move(line, "resolve") } : {}) }, "pair_payment");
		return (await groupPair(owner, card, paid))[0];
	}
	if (action === "retry_rate") {
		const fixed = await reEstimateLine(e, line);
		if (fixed.flag_no_rate === 1) throw new Refused(say("engine.still_no_rate"));
		const changes: Partial<LineRow> = {};
		for (const k of ["bill_minor", "bill_status", "market_rate", "markup", "markup_source", "home_minor", "home_status", "home_rate", "flag_no_rate"] as const) (changes as Record<string, unknown>)[k] = fixed[k];
		if (line.state === "review") changes.state = move(line, "resolve");
		return changeLine(e, line, changes, "retry_rate");
	}
	// accept
	const raised = OWNER_OK_FLAGS.filter((f) => line[`flag_${f}`] === 1);
	// A card payment waiting for its bank leg: "leave it" — never asked again.
	const marks = line.kind === "card_payment" && line.state === "review" && line.transfer_group === null ? [...raised, PAYMENT_PICK] : raised;
	const changes: Partial<LineRow> = { ...okFlags(line, marks), ...Object.fromEntries(raised.map((f) => [`flag_${f}`, 0])) };
	if (line.state === "review") changes.state = move(line, "resolve");
	if (opts.category) changes.category = opts.category;
	return changeLine(owner, line, changes, "accept");
}

function okFlags(line: LineRow, flags: readonly string[]): Partial<LineRow> {
	if (!flags.length) return {};
	const had = (line.owner_ok ?? "").split(",").filter(Boolean);
	return { owner_ok: [...new Set([...had, ...flags])].join(",") };
}

/// A foreign line's bill estimate (and its SGD) worked out again from today's rates.
async function reEstimateLine(e: Engine, line: LineRow): Promise<LineRow> {
	let next = { ...line, flag_no_rate: 0 as const };
	if (line.orig_currency !== line.bill_currency && line.bill_status === "estimate") {
		const found = marketRate(await rateLookup(e.db, line.txn_date), line.txn_date, line.orig_currency, line.bill_currency);
		if (!found) return { ...line, flag_no_rate: 1 };
		const account = (await loadAccounts(e.db)).find((a) => a.id === line.account_id)!;
		const m = markupFor(await learnedMarkup(e.db, account.id, line.orig_currency), account.institution, await markupDefaults(e.db));
		next = { ...next, market_rate: found.rate, markup: m.markup, markup_source: m.source, bill_minor: estimateBill(line.orig_minor, line.orig_currency, line.bill_currency, found.rate, m.markup) + line.fee_minor };
	}
	return withHome(e, { ...next, owner_ok: null });
}

/// The owner looked at a statement that did not add up (or whose bill did not
/// match) and says so: it leaves 待確認. The figures stay as they are.
export async function markStatementReviewed(e: Engine, statementId: string): Promise<void> {
	const r = await e.db.prepare("UPDATE statements SET reviewed_at = ? WHERE id = ?").bind(e.now(), statementId).run();
	if (!r.meta.changes) throw new Refused("no such statement");
}

/// Check a statement again now (after the owner fixed lines): its month and its bill.
export async function recheckAnyStatement(e: Engine, statementId: string): Promise<{ recon: ReconResult; bill_check: string | null }> {
	const statement = await e.db.prepare("SELECT * FROM statements WHERE id = ?").bind(statementId).first<Statement>();
	if (!statement) throw new Refused("no such statement");
	const accounts = await loadAccounts(e.db);
	const account = accounts.find((a) => a.id === statement.account_id)!;
	const recon = await closeStatement(e, statement, account, accounts, statementGroup(accounts, account.id));
	if (recon.ok) await e.db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = ? WHERE kind = 'month_failed' AND ref_id = ? AND status = 'open'").bind(e.now(), statement.id).run();
	const after = await e.db
		.prepare("SELECT bill_check FROM statements WHERE id = COALESCE((SELECT id FROM statements WHERE bill_group = ? AND bill_primary = 1), ?)")
		.bind(statement.bill_group ?? null, statement.id)
		.first<{ bill_check: string | null }>();
	return { recon, bill_check: after?.bill_check ?? null };
}

/// A held alert or statement line (or an Apple Pay tap) the owner says is not a
/// real charge: it leaves 待確認. Evidence is never deleted.
export async function dismissEvidence(e: Engine, evidenceId: string, reason: string | null): Promise<void> {
	const r = await e.db.prepare("UPDATE evidence SET dismissed_at = ?, dismiss_reason = ? WHERE id = ? AND line_id IS NULL").bind(e.now(), reason, evidenceId).run();
	if (!r.meta.changes) throw new Refused("that item is already part of a line, or does not exist");
	await e.db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = ? WHERE ref_id = ? AND status = 'open'").bind(e.now(), evidenceId).run();
}

/// The daily upkeep: an escalated month checked again. Reconciled now → its
/// month_failed escalation is resolved in the same batch as the result.
export async function recheckStatement(e: Engine, statementId: string): Promise<ReconResult | null> {
	const statement = await e.db.prepare("SELECT * FROM statements WHERE id = ? AND recon_status = 'escalated'").bind(statementId).first<Statement>();
	if (!statement) return null;
	const accounts = await loadAccounts(e.db);
	const account = accounts.find((a) => a.id === statement.account_id);
	if (!account) return null;
	const recon = await closeStatement(e, statement, account, accounts, statementGroup(accounts, account.id));
	if (recon.ok) await e.db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = ? WHERE kind = 'month_failed' AND ref_id = ? AND status = 'open'").bind(e.now(), statement.id).run();
	return recon;
}

async function homeOnly(e: Engine, line: LineRow): Promise<Pick<LineRow, "home_minor" | "home_status" | "home_rate">> {
	const s = await withHome(e, line);
	return { home_minor: s.home_minor, home_status: s.home_status, home_rate: s.home_rate };
}

/// The owner's FX rule, at the moment of confirmation: record the effective rate
/// and observed markup, and teach the card — in ONE batch, so a resumed import
/// never confirms a line without learning from it. Re-estimating the card's
/// other open estimates follows (reEstimate), once per statement.
async function confirmForeign(e: Engine, line: LineRow): Promise<void> {
	const rate = line.market_rate ?? marketRate(await rateLookup(e.db, line.txn_date), line.txn_date, line.orig_currency, line.bill_currency)?.rate ?? null;
	const changes: Partial<LineRow> = { bill_status: "confirmed", market_rate: rate };
	if (rate !== null && line.orig_minor !== 0) {
		const o = observe(line.bill_minor, line.orig_minor, line.orig_currency, line.bill_currency, rate);
		Object.assign(changes, { effective_rate: o.effective_rate, observed_markup: o.observed_markup });
	}
	const extra: Bound[] = [];
	const observed = changes.observed_markup ?? null;
	if (observed !== null && shouldLearn(line.kind, line.orig_minor, observed, line.txn_date, await learnedMarkup(e.db, line.account_id, line.orig_currency))) {
		extra.push(
			e.db
				.prepare(
					"INSERT INTO card_fx_markups (account_id, currency, markup, observed_txn_date, observed_line_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
						"ON CONFLICT (account_id, currency) DO UPDATE SET markup = excluded.markup, observed_txn_date = excluded.observed_txn_date, observed_line_id = excluded.observed_line_id, updated_at = excluded.updated_at",
				)
				.bind(line.account_id, line.orig_currency, observed, line.txn_date, line.id, e.now()),
		);
	}
	await changeLine(e, line, { ...changes, ...(await homeOnly(e, { ...line, ...changes } as LineRow)) }, "confirm_fx", extra);
}

/// A card's open estimates in one currency, re-estimated with the markup it
/// just learned. Safe to repeat: an estimate already right is not touched.
async function reEstimate(e: Engine, accountId: string, currency: string, markup: number): Promise<void> {
	const open = (
		await e.db
			.prepare("SELECT * FROM lines WHERE account_id = ? AND orig_currency = ? AND bill_status = 'estimate' AND state <> 'void' AND market_rate IS NOT NULL")
			.bind(accountId, currency)
			.all<LineRow>()
	).results;
	for (const est of open) {
		const bill = estimateBill(est.orig_minor, est.orig_currency, est.bill_currency, est.market_rate!, markup);
		const next = { ...est, bill_minor: bill, markup, markup_source: "learned" as const };
		await changeLine(e, est, { bill_minor: bill, markup, markup_source: next.markup_source, ...(await homeOnly(e, next)) }, "re_estimate");
	}
}

/// The owner's rule: an estimate (or any alert-only line) its statement has come
/// and gone without is flagged. Recomputed for the whole statement group;
/// returned for the statement's closing batch.
async function notOnStatementChanges(e: Engine, statementAccount: string, group: ReadonlySet<string>, lagDays?: number): Promise<{ line: LineRow; changes: Pick<LineRow, "flag_not_on_statement"> }[]> {
	const statements = (await e.db.prepare("SELECT period_start, period_end FROM statements WHERE account_id = ?").bind(statementAccount).all<{ period_start: string; period_end: string }>()).results;
	const ids = [...group];
	// A wallet's offset lines are the ledger's own: never on any statement.
	const waiting = (
		await e.db
			.prepare(`SELECT * FROM lines WHERE statement_id IS NULL AND state <> 'void' AND kind <> 'wallet_offset' AND account_id IN (${placeholders(ids.length)})`)
			.bind(...ids)
			.all<LineRow>()
	).results;
	return waiting.map((l) => ({ line: l, changes: { flag_not_on_statement: isNotOnStatement(l, statements, lagDays) && !ownerOk(l, "not_on_statement") ? 1 : 0 } }));
}

// ------------------------------------------------------------- the owner's edits

export interface CashIn {
	txn_date: string;
	currency: string;
	amount_minor: number; // + spent
	merchant: string;
	category?: string | null;
	note?: string | null;
	/// What it cost in SGD, if the owner knows (e.g. the rate he changed money at).
	home_minor?: number | null;
	/// Where the money came from: cash (default), a wallet (GrabPay), or a card
	/// (a purchase no alert or tap brought — addCardSpend). Never a bank account:
	/// its lines come from its alerts and statements.
	account_id?: string | null;
}

export async function addCash(e: Engine, c: CashIn): Promise<LineRow> {
	const accounts = await loadAccounts(e.db);
	if (c.account_id) {
		const target = accounts.find((a) => a.id === c.account_id);
		if (isWallet(target)) return addWalletSpend(e, target, c);
		if (target && isCard(target)) return addCardSpend(e, target, accounts, c);
		if (target?.kind !== "cash") throw new Refused("spending can be added by hand only to cash, a wallet (GrabPay, a prepaid card) or a card; a bank account's lines come from its alerts and statements");
	}
	const cash = accounts.find((a) => (c.account_id ? a.id === c.account_id : a.kind === "cash"));
	if (!cash) throw new Refused("there is no cash account on the account list");
	const id = e.newId();
	const known = c.home_minor !== null && c.home_minor !== undefined && c.currency !== homeCurrency();
	let line = await buildLine(e, cash, c.amount_minor < 0 ? "refund" : "purchase", { txn_date: c.txn_date, currency: c.currency, amount_minor: c.amount_minor, merchant_raw: c.merchant }, {
		id,
		category: c.category ?? null,
		note: c.note ?? null,
		created_by: "owner",
	});
	if (known) line = { ...line, home_minor: c.home_minor!, home_status: "confirmed", home_set_by: "owner", flag_no_rate: 0 };
	const ev: Evidence = {
		id: e.newId(),
		type: "manual",
		line_id: id,
		message_id: null,
		statement_id: null,
		fingerprint: manualFingerprint(id),
		institution: "cash",
		last4: null,
		txn_date: c.txn_date,
		txn_time: null,
		post_date: null,
		currency: c.currency,
		amount_minor: c.amount_minor,
		bill_currency: null,
		bill_minor: null,
		merchant_raw: c.merchant,
		merchant_country: null,
		kind_hint: null,
		details_json: null,
		created_at: line.created_at,
	};
	await e.db.batch([insertRow(e.db, "lines", line), insertRow(e.db, "evidence", ev), lineEvent(e.db, id, line.created_at, "owner", "create", null, { type: "manual" })]);
	return line;
}

const isCard = (a: Account): boolean => a.kind === "credit_card" || a.kind === "debit_card";

/// The owner's word for a card purchase no alert or tap brought (21 Oct
/// 2026: an Apple Pay under Citi's alert threshold on a day his Shortcut was
/// failing). It behaves like a tap on that card — the card's own kind rules
/// and the owner's payee rules, an estimate if foreign, provisional until the
/// statement — so the statement line (or a late alert or tap) for the same
/// purchase JOINS it through the ordinary matching, never a second line. Its
/// evidence is 'manual' (the page's 「你手動加的」), not a tap: a tap row would
/// tell the Shortcut's own check that the Shortcut worked, and would stop the
/// real tap, if it ever came, from joining.
async function addCardSpend(e: Engine, card: Account, accounts: readonly Account[], c: CashIn): Promise<LineRow> {
	if (c.home_minor !== null && c.home_minor !== undefined) throw new Refused(`${card.name} is a card: its statement confirms what it cost in ${homeCurrency()}; give the amount only`);
	const owner = { ...e, actor: "owner" as const };
	const rule = ruleForLine(merchantKey(c.merchant, e.aliases), isTransferLine(card.kind, c.merchant, null), await payeeRules(e));
	const kindResult = withCardCounter(
		withPayeeRule(classifyKind({ kind_hint: c.amount_minor < 0 ? "refund" : "purchase", merchant_raw: c.merchant, amount_minor: c.amount_minor, details: {}, txn_date: c.txn_date }, card, accounts, e.ownNames), c.amount_minor, rule),
		card,
		c.merchant,
		accounts,
	);
	// Already in the ledger (an alert or tap for that card, amount, same or next day —
	// or its statement line): his word joins that line. The tap's own matching decides,
	// over the closer window a wallet uses, so his word never swallows another day's purchase.
	const ids = new Set([card.id]);
	const near = (await candidatesNear(e.db, ids, c.txn_date)).filter((x) => Math.abs(daysBetween(x.line.txn_date, c.txn_date)) <= 1);
	const decision = matchEvidence({ type: "manual", account_ids: ids, kind: kindResult.kind, currency: c.currency, amount_minor: c.amount_minor, txn_date: c.txn_date, merchant_key: merchantKey(c.merchant, e.aliases) }, near);
	if (decision.action === "review" || decision.action === "hold") {
		// ("hold" is a receipt's answer only; kept so a change there cannot slip a second line in.)
		const fit = decision.action === "review" ? new Set(decision.candidate_ids) : new Set<string>();
		const which = near.filter((x) => fit.has(x.line.id));
		throw new Refused(
			`${which.length} ${card.name} lines of that amount around that day are already in the ledger (${which.map((x) => `${x.line.id}: ${x.line.txn_date} ${x.line.merchant_name ?? x.line.merchant_raw ?? ""}`).join("; ")}); nothing was added. If this is one of them, nothing needs adding; if it is another purchase, give a clearer merchant name`,
		);
	}
	if (decision.action === "attach") {
		const found = near.find((x) => x.line.id === decision.line_id)!.line;
		const now = e.now();
		const ev = manualEvidence(e, card, c, found.id, now);
		await e.db.batch([insertRow(e.db, "evidence", ev), lineEvent(e.db, found.id, now, "owner", "evidence", null, { evidence_id: ev.id, type: "manual" })]);
		// His category is his word (a 'category' event, so no later rule moves it), and
		// his note fills an empty one; the amount and merchant stay the bank's.
		let joined = found;
		if (c.category && (found.kind === "purchase" || found.kind === "refund")) joined = await changeLine(owner, joined, { category: c.category }, "category");
		if (c.note && !joined.note) joined = await changeLine(owner, joined, { note: c.note }, "note");
		return joined;
	}
	const id = e.newId();
	let line = await buildLine(owner, card, kindResult.kind, { txn_date: c.txn_date, currency: c.currency, amount_minor: c.amount_minor, merchant_raw: c.merchant }, {
		id,
		counter_account_id: kindResult.counter_account_id,
		...ruleCategory(kindResult.kind, rule),
		...(c.category && (kindResult.kind === "purchase" || kindResult.kind === "refund") ? { category: c.category } : {}),
		note: c.note ?? null,
	});
	if (kindResult.review) line = { ...line, state: "review" };
	const ev = manualEvidence(e, card, c, id, line.created_at);
	await e.db.batch([insertRow(e.db, "lines", line), insertRow(e.db, "evidence", ev), lineEvent(e.db, id, line.created_at, "owner", "create", null, { evidence_id: ev.id, type: "manual" })]);
	if (kindResult.review) await escalate(e, "line_unsure", id, "looks like a card bill at an issuer not on the account list");
	await afterCreate(owner, line, kindResult.counter_account_id, accounts);
	await absorbHandLine(owner, line, accounts);
	return (await getLine(e.db, id)) ?? line;
}

/// The evidence row of the owner's word about a purchase on `account`.
function manualEvidence(e: Engine, account: Account, c: CashIn, lineId: string, at: string): Evidence {
	return {
		id: e.newId(),
		type: "manual",
		line_id: lineId,
		message_id: null,
		statement_id: null,
		fingerprint: manualFingerprint(e.newId()),
		institution: account.institution,
		last4: account.last4,
		txn_date: c.txn_date,
		txn_time: null,
		post_date: null,
		currency: c.currency,
		amount_minor: c.amount_minor,
		bill_currency: null,
		bill_minor: null,
		merchant_raw: c.merchant,
		merchant_country: null,
		kind_hint: null,
		details_json: null,
		created_at: at,
	};
}

/// The owner fixes the home-currency figure of a line no statement will ever confirm (cash,
/// a 台新 TWD line). A card estimate is not his to fix: its statement will.
export async function correctHome(e: Engine, lineId: string, homeMinor: number): Promise<LineRow> {
	const line = await getLine(e.db, lineId);
	if (!line) throw new Refused("no such line");
	const accounts = await loadAccounts(e.db);
	const isCash = accounts.find((a) => a.id === line.account_id)?.kind === "cash";
	if (line.home_status !== "reference" && !isCash) throw new Refused("only a cash or reference-rate line can be corrected by hand; a card's statement confirms it");
	if (!Number.isSafeInteger(homeMinor)) throw new Refused(`the ${homeCurrency()} amount must be a whole number of its smallest unit`);
	return changeLine({ ...e, actor: "owner" }, line, { home_minor: homeMinor, home_status: "confirmed", home_set_by: "owner" }, "correct_home");
}

export async function setReimbursable(e: Engine, lineId: string, value: 0 | 1 | null): Promise<LineRow> {
	const line = await getLine(e.db, lineId);
	if (!line) throw new Refused("no such line");
	if (line.kind === "wallet_offset") throw new Refused(OFFSET_REFUSED);
	return changeLine({ ...e, actor: "owner" }, line, { reimbursable_override: value }, "reimbursable");
}

export async function addReimburseRange(e: Engine, start: string, end: string, note: string | null): Promise<string> {
	const id = e.newId();
	await insertRow(e.db, "reimburse_ranges", { id, start_date: start, end_date: end, note, created_at: e.now() }).run();
	return id;
}

// --------------------------------------------- the owner's edits, from the page and the connector
//
// Trips, subscriptions, reimbursable ranges and Wallet card names are not
// ledger lines, but they are the owner's word, so they too are written only here.
// Every one is a single guarded statement or one batch: a second tab or the
// daily run changing the same row in between is refused, never overwritten.

export type TripAction = "confirm" | "dismiss" | "restore";

const TRIP_TARGET: Readonly<Record<TripAction, TripStatus>> = { confirm: "confirmed", dismiss: "dismissed", restore: "proposed" };

interface TripStatusRow {
	id: string;
	status: TripStatus;
	start_date: string;
	end_date: string;
	confirmed_at: string | null;
}

async function tripRow(db: Db, tripId: string): Promise<TripStatusRow> {
	const trip = await db.prepare("SELECT id, status, start_date, end_date, confirmed_at FROM trips WHERE id = ?").bind(tripId).first<TripStatusRow>();
	if (!trip) throw new Refused("no such trip");
	return trip;
}

/// proposed → confirmed | dismissed; dismissed → proposed (restore); a
/// confirmed trip stays confirmed (confirming it again changes nothing).
export async function setTripStatus(e: Engine, tripId: string, action: TripAction): Promise<void> {
	const trip = await tripRow(e.db, tripId);
	const to = TRIP_TARGET[action];
	if (!canMoveTrip(trip.status, to)) throw new Refused(`a ${trip.status} trip cannot be ${action === "confirm" ? "confirmed" : action === "dismiss" ? "dismissed" : "restored"}`);
	if (trip.status === to) return;
	const now = e.now();
	const r = await e.db
		.prepare("UPDATE trips SET status = ?, confirmed_at = ?, updated_at = ? WHERE id = ? AND status = ?")
		.bind(to, to === "confirmed" ? now : trip.confirmed_at, now, tripId, trip.status)
		.run();
	if (r.meta.changes !== 1) throw new Refused("the trip changed while you were looking at it; look again and retry");
}

export interface TripEdit {
	name?: string | null;
	start_date?: string;
	end_date?: string;
	include_line_ids?: readonly string[];
	exclude_line_ids?: readonly string[];
	/// Confirm it in the SAME write, so the daily run cannot move a proposed
	/// trip's dates between the owner's correction and his confirmation.
	confirm?: boolean;
}

/// Rename a trip, move its dates, or include/exclude single lines. The owner's
/// include/exclude always beats the automatic membership. A dismissed trip is
/// not edited: restore it first.
///
/// Every edit stamps trips.owner_edited_at (migration 0002): the daily run's
/// trip proposals must leave a trip the owner has touched alone, even while it is
/// still only proposed.
export async function editTrip(e: Engine, tripId: string, edit: TripEdit): Promise<void> {
	const trip = await tripRow(e.db, tripId);
	if (trip.status === "dismissed") throw new Refused(edit.confirm ? "a dismissed trip cannot be confirmed; restore it first" : "a dismissed trip cannot be edited; restore it first");
	const start = edit.start_date ?? trip.start_date;
	const end = edit.end_date ?? trip.end_date;
	if (!isIsoDate(start) || !isIsoDate(end)) throw new Refused("trip dates must be YYYY-MM-DD");
	if (start > end) throw new Refused("the trip ends before it starts");
	const include = [...new Set(edit.include_line_ids ?? [])];
	const exclude = [...new Set(edit.exclude_line_ids ?? [])];
	const both = include.filter((id) => exclude.includes(id));
	if (both.length) throw new Refused(`a line cannot be both included and excluded: ${both.join(", ")}`);
	const wanted = [...include, ...exclude];
	if (wanted.length) {
		// One bound value whatever the count (D1 refuses more than 100).
		const found = (await e.db.prepare("SELECT id FROM lines WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(wanted)).all<{ id: string }>()).results;
		const missing = wanted.filter((id) => !found.some((f) => f.id === id));
		if (missing.length) throw new Refused(`no such line: ${missing.join(", ")}`);
	}
	const now = e.now();
	const stmts: Bound[] = [];
	const changes: Record<string, unknown> = { start_date: start, end_date: end, updated_at: now, owner_edited_at: now };
	if (edit.confirm && trip.status !== "confirmed") Object.assign(changes, { status: "confirmed", confirmed_at: now });
	if (edit.name !== undefined) changes.name = edit.name === null || edit.name.trim() === "" ? null : edit.name.trim();
	const cols = Object.keys(changes);
	stmts.push(
		e.db
			.prepare(`UPDATE trips SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND status = ?`)
			.bind(...Object.values(changes), tripId, trip.status),
	);
	for (const [ids, membership] of [
		[include, "included"],
		[exclude, "excluded"],
	] as const) {
		for (const id of ids) {
			stmts.push(
				e.db
					.prepare("INSERT INTO trip_lines (trip_id, line_id, membership) VALUES (?, ?, ?) ON CONFLICT (trip_id, line_id) DO UPDATE SET membership = excluded.membership")
					.bind(tripId, id, membership),
			);
		}
	}
	const [updated] = await e.db.batch(stmts);
	if (updated!.meta.changes !== 1) throw new Refused("the trip changed while you were looking at it; look again and retry");
}

export type SubscriptionAction = "ignore" | "cancelled" | "active" | "restore";

/// The owner's word on a subscription beats detection: "ignore" (not really a
/// subscription — and its merchant is never proposed again), "cancelled" (he
/// stopped it), "active" (still running: 訂閱中 whatever detection says),
/// "restore" (back to detection).
export async function setSubscriptionStatus(e: Engine, subscriptionId: string, action: SubscriptionAction): Promise<void> {
	const value = action === "ignore" ? "ignored" : action === "cancelled" ? "cancelled" : action === "active" ? "active" : null;
	const r = await e.db.prepare("UPDATE subscriptions SET owner_status = ?, updated_at = ? WHERE id = ?").bind(value, e.now(), subscriptionId).run();
	if (r.meta.changes !== 1) throw new Refused("no such subscription");
}

export async function removeReimburseRange(e: Engine, rangeId: string): Promise<void> {
	const r = await e.db.prepare("DELETE FROM reimburse_ranges WHERE id = ?").bind(rangeId).run();
	if (r.meta.changes !== 1) throw new Refused("no such reimbursable range");
}

/// An Apple Wallet card name → one of the owner's cards, then every tap held for
/// that name is tried again. A name already given to another card is refused,
/// never moved: a tap must never be guessed onto the wrong card.
/// How many held taps one naming retries at once (see retryHeldTaps).
export const WALLET_RETRY_LIMIT = 4;

export async function addWalletName(e: Engine, name: string, accountId: string): Promise<{ wallet_key: string; retried: IngestResult[]; still_held: number }> {
	const key = walletKey(name);
	if (!key) throw new Refused("the Wallet card name is empty");
	const account = (await loadAccounts(e.db)).find((a) => a.id === accountId);
	if (!account) throw new Refused("no such account");
	if (account.kind !== "credit_card" && account.kind !== "debit_card") throw new Refused("only a card has an Apple Wallet name");
	const existing = await e.db.prepare("SELECT account_id FROM account_wallet_names WHERE wallet_key = ?").bind(key).first<{ account_id: string }>();
	if (existing && existing.account_id !== accountId) throw new Refused(`the Wallet name "${key}" already belongs to another card`);
	if (!existing) await e.db.prepare("INSERT OR IGNORE INTO account_wallet_names (wallet_key, account_id) VALUES (?, ?)").bind(key, accountId).run();
	const after = await e.db.prepare("SELECT account_id FROM account_wallet_names WHERE wallet_key = ?").bind(key).first<{ account_id: string }>();
	if (after?.account_id !== accountId) throw new Refused(`the Wallet name "${key}" already belongs to another card`);
	// The taps themselves are evidence, not the owner's edits: the rules file them.
	const retried = await retryHeldTaps({ ...e, actor: "rules" }, { walletKey: key, limit: WALLET_RETRY_LIMIT });
	const left = await e.db
		.prepare("SELECT COUNT(*) AS n FROM evidence WHERE type = 'apple_pay_shortcut' AND line_id IS NULL AND json_extract(details_json, '$.wallet_key') = ?")
		.bind(key)
		.first<{ n: number }>();
	return { wallet_key: key, retried, still_held: left?.n ?? 0 };
}

/// The playbook's category rules, filled into lines that have no category yet.
/// Only an EMPTY category is filled: one the owner gave (a cash line) or one already
/// set is never overwritten. A rule with a `kind` applies to that kind only.
/// `limit` lines per call (each costs its UPDATE and its event) — call again
/// while it returns a full batch. Returns how many lines it categorised.
export async function applyCategoryRules(e: Engine, rules: readonly { merchant_key: string; category: string; kind?: LineKind }[], limit: number): Promise<number> {
	if (!rules.length || limit <= 0) return 0;
	const any = new Map<string, string>(); // merchant_key → category, any kind
	const byKind: { merchant_key: string; kind: LineKind; category: string }[] = [];
	for (const r of rules) {
		if (r.kind) byKind.push({ merchant_key: r.merchant_key, kind: r.kind, category: r.category });
		else if (!any.has(r.merchant_key)) any.set(r.merchant_key, r.category);
	}
	const found: { id: string; category: string }[] = [];
	const take = async (sql: string, args: unknown[], categoryOf: (row: { id: string; kind: LineKind; merchant_key: string }) => string | undefined) => {
		if (found.length >= limit) return;
		const rows = await e.db.prepare(`SELECT id, kind, merchant_key FROM lines WHERE category IS NULL AND state <> 'void' AND ${sql} LIMIT ?`).bind(...args, limit - found.length).all<{ id: string; kind: LineKind; merchant_key: string }>();
		for (const row of rows.results) {
			const category = categoryOf(row);
			if (category && !found.some((f) => f.id === row.id)) found.push({ id: row.id, category });
		}
	};
	// A kind-specific rule first (it is the narrower one), then the any-kind rules.
	for (const r of byKind) await take("merchant_key = ? AND kind = ?", [r.merchant_key, r.kind], () => r.category);
	// D1 caps bound parameters per statement (100): ask in slices of 90 keys.
	const keys = [...any.keys()];
	for (let i = 0; i < keys.length; i += 90) {
		const slice = keys.slice(i, i + 90);
		await take(`merchant_key IN (${placeholders(slice.length)})`, slice, (row) => any.get(row.merchant_key));
	}
	const at = e.now();
	const stmts: Bound[] = [];
	for (const l of found) {
		stmts.push(
			e.db.prepare("UPDATE lines SET category = ?, updated_at = ? WHERE id = ? AND category IS NULL").bind(l.category, at, l.id),
			lineEvent(e.db, l.id, at, e.actor, "categorise", { category: null }, { category: l.category }),
		);
	}
	if (stmts.length) await e.db.batch(stmts);
	return found.length;
}

/// The owner puts one line in a category. That line is then his: a later rule for
/// its merchant (his or a model's) never moves it.
export async function setLineCategory(e: Engine, lineId: string, category: string): Promise<LineRow> {
	const line = await getLine(e.db, lineId);
	if (!line) throw new Refused("no such line");
	return changeLine({ ...e, actor: "owner" }, line, { category }, "category");
}

/// The owner's merchant rules hold over a model's: every line of such a merchant
/// that sits in another category moves — except a line the owner categorised one by
/// one. `limit` lines per call; returns how many moved (call again while it
/// returns `limit`). Rules go in slices so a statement binds under D1's 100.
export async function enforceOwnerRules(e: Engine, rules: readonly { merchant_key: string; category: string }[], limit: number): Promise<number> {
	const found: { id: string; from: string | null; to: string }[] = [];
	for (let i = 0; i < rules.length && found.length < limit; i += 45) {
		const slice = rules.slice(i, i + 45);
		const rows = await e.db
			.prepare(
				`SELECT id, category, merchant_key FROM lines l WHERE state <> 'void' AND (${slice.map(() => "(merchant_key = ? AND (category IS NULL OR category <> ?))").join(" OR ")}) AND NOT EXISTS (SELECT 1 FROM line_events v WHERE v.line_id = l.id AND v.actor = 'owner' AND v.event = 'category') LIMIT ?`,
			)
			.bind(...slice.flatMap((r) => [r.merchant_key, r.category]), limit - found.length)
			.all<{ id: string; category: string | null; merchant_key: string }>();
		for (const row of rows.results) found.push({ id: row.id, from: row.category, to: slice.find((r) => r.merchant_key === row.merchant_key)!.category });
	}
	if (!found.length) return 0;
	const at = e.now();
	const stmts: Bound[] = [];
	for (const l of found) {
		stmts.push(
			e.db.prepare("UPDATE lines SET category = ?, updated_at = ? WHERE id = ?").bind(l.to, at, l.id),
			lineEvent(e.db, l.id, at, e.actor, "categorise", { category: l.from }, { category: l.to }),
		);
	}
	await e.db.batch(stmts);
	return found.length;
}

/// The owner starts a trip himself (no flight or hotel email needed): confirmed at
/// once, his own. Its overseas spending between the dates joins automatically;
/// he adds or removes any line with editTrip.
export async function createTrip(e: Engine, t: { name: string; start_date: string; end_date: string; destination?: string | null }): Promise<string> {
	const name = t.name.trim();
	if (!name) throw new Refused("give the trip a name");
	if (!isIsoDate(t.start_date) || !isIsoDate(t.end_date)) throw new Refused("trip dates must be YYYY-MM-DD");
	if (t.start_date > t.end_date) throw new Refused("the trip ends before it starts");
	const id = e.newId();
	const now = e.now();
	await e.db
		.prepare(
			"INSERT INTO trips (id, name, destination, countries_json, start_date, end_date, status, evidence_ids_json, confirmed_at, created_at, updated_at, owner_edited_at) VALUES (?, ?, ?, '[]', ?, ?, 'confirmed', '[]', ?, ?, ?, ?)",
		)
		.bind(id, name, t.destination?.trim() || name, t.start_date, t.end_date, now, now, now, now)
		.run();
	return id;
}

export type IncomeOffset = { to: "salary" } | { to: "card"; account_id: string } | { to: "line"; line_id: string } | { to: "none" };

/// The category an income line marked as salary carries.
export const SALARY_CATEGORY = "Salary";

/// The owner says what an incoming payment offsets, so his totals are true:
///   salary — it is his pay: income, never spending;
///   card   — it reduces that card's spending (a friend's share of a card bill);
///   line   — it pays back one purchase: that purchase's net cost, category and
///            trip all go down (it becomes that purchase's refund);
///   none   — back to ordinary income.
/// Only money IN can be an offset; a card payment or own-account transfer cannot.
export async function setIncomeOffset(e: Engine, lineId: string, offset: IncomeOffset): Promise<LineRow> {
	const line = await getLine(e.db, lineId);
	if (!line) throw new Refused("no such line");
	const incoming = line.kind === "income" || (line.kind === "refund" && line.income_offset != null);
	if (!incoming || line.home_minor > 0) throw new Refused("only money you received (income) can offset something");
	const owner = { ...e, actor: "owner" as const };
	if (offset.to === "none") {
		return changeLine(owner, line, { kind: "income", income_offset: null, offset_account_id: null, refund_of: null, category: line.income_offset === "salary" ? null : line.category, flag_unlinked_refund: 0 }, "income_offset");
	}
	if (offset.to === "salary") {
		return changeLine(owner, line, { kind: "income", income_offset: "salary", offset_account_id: null, refund_of: null, category: SALARY_CATEGORY, flag_unlinked_refund: 0 }, "income_offset");
	}
	if (offset.to === "card") {
		const accounts = await loadAccounts(e.db);
		const card = accounts.find((a) => a.id === offset.account_id);
		if (!card || card.kind !== "credit_card") throw new Refused("choose one of your credit cards");
		return changeLine(owner, line, { kind: "refund", income_offset: "card", offset_account_id: card.id, refund_of: null, category: null, flag_unlinked_refund: 0 }, "income_offset");
	}
	const target = await getLine(e.db, offset.line_id);
	if (!target || target.id === line.id) throw new Refused("no such purchase to offset");
	if (target.state === "void" || !["purchase", "fee"].includes(target.kind)) throw new Refused("an income can only pay back a purchase");
	return changeLine(owner, line, { kind: "refund", income_offset: "line", offset_account_id: target.account_id, refund_of: target.id, category: target.category, flag_unlinked_refund: 0 }, "income_offset");
}

// ------------------------------------------------------------ the owner's payee rules

const RULES_CACHE = new WeakMap<Engine, Promise<PayeeRule[]>>();

/// The owner's payee rules (migration 0006), read once per engine. An engine is
/// made per request or per tick, so a rule he just set is seen by the next one.
export function payeeRules(e: Engine): Promise<PayeeRule[]> {
	let p = RULES_CACHE.get(e);
	if (!p) {
		p = e.db
			.prepare("SELECT * FROM payee_rules")
			.bind()
			.all<PayeeRule>()
			.then((r) => r.results)
			.catch(() => []); // before migration 0006: no rules (never a reason to stop reading mail)
		RULES_CACHE.set(e, p);
	}
	return p;
}

/// The rules' kind beats detection's, at the moment a line is classified, so
/// the alert and the statement line of one payment agree and match.
function withPayeeRule<K extends { kind: LineKind; counter_account_id: string | null; review: boolean }>(k: K, amountMinor: number, rule: PayeeRule | null): K {
	if (!rule?.kind) return k;
	const kind = kindUnder({ kind: k.kind, bill_minor: amountMinor }, rule.kind);
	return kind ? { ...k, kind, review: false } : k;
}

function ruleCategory(kind: LineKind, rule: PayeeRule | null): Partial<LineRow> {
	return rule?.category && (kind === "purchase" || kind === "refund") ? { category: rule.category } : {};
}

/// Lines of these transfer groups other than `ids`: the other legs of pairs
/// that stop being transfers (they are then unpaired, never left half-paired).
async function otherLegs(db: Db, groups: readonly string[], ids: ReadonlySet<string>): Promise<LineRow[]> {
	if (!groups.length) return [];
	const out: LineRow[] = [];
	for (let i = 0; i < groups.length; i += 90) {
		const slice = groups.slice(i, i + 90);
		const rows = await db.prepare(`SELECT * FROM lines WHERE transfer_group IN (${placeholders(slice.length)})`).bind(...slice).all<LineRow>();
		out.push(...rows.results.filter((r) => !ids.has(r.id)));
	}
	return out;
}

/// Write many lines' changes, two statements per distinct set of columns
/// (bulkChange) however many lines. A line whose new kind is not a transfer
/// leaves its pair. Never the SGD columns. Returns how many lines changed.
export async function writeChanges(e: Engine, event: string, items: { line: LineRow; changes: Partial<LineRow> }[]): Promise<number> {
	const work = items.filter((x) => Object.entries(x.changes).some(([k, v]) => x.line[k as keyof LineRow] !== v));
	if (!work.length) return 0;
	// A bank line becoming a card bill (a payee rule, the owner's word) keeps the
	// card it paid, named by its descriptor, so 繳款 counts it (14 Oct
	// 2026: HSBC 5502's bill showed 逾期 though the DBS payment was there).
	if (work.some((x) => x.changes.kind === "card_payment")) {
		const accounts = await loadAccounts(e.db);
		for (const x of work) {
			if (x.changes.kind !== "card_payment") continue;
			const own = accounts.find((a) => a.id === x.line.account_id);
			if (!own) continue;
			const counter = "counter_account_id" in x.changes ? (x.changes.counter_account_id ?? null) : (x.line.counter_account_id ?? null);
			const k = withCardCounter({ kind: "card_payment" as LineKind, counter_account_id: counter }, own, x.line.merchant_raw, accounts);
			if (k.counter_account_id !== counter) x.changes = { ...x.changes, counter_account_id: k.counter_account_id };
		}
	}
	const leaving = work.filter((x) => x.changes.kind && x.line.transfer_group && x.changes.kind !== "transfer" && x.changes.kind !== "card_payment");
	for (const x of leaving) x.changes = { ...x.changes, transfer_group: null };
	const ids = new Set(work.map((x) => x.line.id));
	for (const leg of await otherLegs(e.db, [...new Set(leaving.map((x) => x.line.transfer_group!))], ids)) {
		work.push({ line: leg, changes: { transfer_group: null } });
		ids.add(leg.id);
	}
	const byCols = new Map<string, { line: LineRow; changes: Partial<LineRow> }[]>();
	for (const x of work) {
		const sig = Object.keys(x.changes).sort().join();
		(byCols.get(sig) ?? byCols.set(sig, []).get(sig)!).push(x);
	}
	const at = e.now();
	const stmts: Bound[] = [];
	for (const group of byCols.values()) {
		for (let i = 0; i < group.length; i += 200) stmts.push(...bulkChange(e, event, at, group.slice(i, i + 200)));
	}
	if (stmts.length) await e.db.batch(stmts);
	// A kind changed on (or to) a wallet's line: its legs and offsets follow.
	await tidyWalletsOf(e, work.filter((x) => x.changes.kind !== undefined || x.changes.state !== undefined).map((x) => x.line));
	return ids.size;
}

/// The owner says what one line's money is (his word on this line only: the look
/// back never moves it back, until he sets a rule for the payee afterwards).
export async function setLineKind(e: Engine, lineId: string, kind: OwnerKind): Promise<LineRow> {
	if (!(OWNER_KINDS as readonly string[]).includes(kind)) throw new Refused(`unknown kind ${kind}`);
	const line = await getLine(e.db, lineId);
	if (!line) throw new Refused("no such line");
	if (line.kind === "wallet_offset") throw new Refused(OFFSET_REFUSED);
	if (line.state === "void") throw new Refused("that line was removed");
	const to = kind === line.kind ? null : kindUnder(line, kind);
	if (to === null && line.kind !== kind && !(kind === "purchase" && (line.kind === "refund" || line.kind === "purchase"))) {
		throw new Refused(line.income_offset ? "you already said what this incoming money offsets; change that first" : `a ${line.kind} line cannot be marked ${kind}`);
	}
	if (to === null) return line;
	const owner = { ...e, actor: "owner" as const };
	await writeChanges(owner, "kind", [{ line, changes: { kind: to } }]);
	return (await getLine(e.db, lineId))!;
}

/// The lines this rule covers now, under ALL the rules (the longest rule wins;
/// a masked name only when one rule fits; a card line only by exactly the
/// name, and only when the owner made the rule from a card line — ruleForLine).
async function linesCoveredBy(e: Engine, ruleKey: string): Promise<LineRow[]> {
	const rules = await payeeRules(e);
	const kinds = new Map((await loadAccounts(e.db)).map((a) => [a.id, a.kind]));
	const keys = (await e.db.prepare("SELECT DISTINCT merchant_key FROM lines WHERE merchant_key IS NOT NULL").bind().all<{ merchant_key: string }>()).results.map((r) => r.merchant_key);
	const maybe = keys.filter((k) => ruleFor(k, rules)?.merchant_key === ruleKey || ruleForLine(k, false, rules)?.merchant_key === ruleKey);
	const lines: LineRow[] = [];
	for (let i = 0; i < maybe.length; i += 90) {
		const slice = maybe.slice(i, i + 90);
		lines.push(...(await e.db.prepare(`SELECT * FROM lines WHERE state <> 'void' AND merchant_key IN (${placeholders(slice.length)})`).bind(...slice).all<LineRow>()).results);
	}
	return lines.filter((l) => ruleForLine(l.merchant_key, isTransferLine(kinds.get(l.account_id), l.merchant_raw, l.kind), rules)?.merchant_key === ruleKey);
}

/// The owner's word on a payee (kind and/or category; a field left undefined keeps
/// what the rule had). Saved as his rule — every later line follows it — and
/// applied now to every line of the payee he already has, including lines he
/// had set one by one ("以前和以後的都這樣"). A rule covers transfer lines;
/// `cardLines` (the owner made it from a card line, or named the merchant himself)
/// lets it also cover card lines of exactly that name. Returns the lines changed.
export async function setPayeeRule(e: Engine, merchantKey: string, set: { kind?: OwnerKind | null; category?: string | null }, opts: { cardLines?: boolean } = {}): Promise<{ rule: PayeeRule; changed: number }> {
	const key = merchantKey.trim().toUpperCase();
	if (!key) throw new Refused("this line has no payee name to remember");
	const old = await e.db.prepare("SELECT * FROM payee_rules WHERE merchant_key = ?").bind(key).first<PayeeRule>();
	const rule: PayeeRule = {
		merchant_key: key,
		kind: set.kind !== undefined ? set.kind : (old?.kind ?? null),
		category: set.category !== undefined ? set.category : (old?.category ?? null),
		set_by: "owner",
		updated_at: e.now(),
		card_lines: opts.cardLines || old?.card_lines === 1 ? 1 : 0,
	};
	if (!rule.kind && !rule.category) {
		await e.db.prepare("DELETE FROM payee_rules WHERE merchant_key = ?").bind(key).run();
		return { rule, changed: 0 };
	}
	await e.db
		.prepare(
			"INSERT INTO payee_rules (merchant_key, kind, category, set_by, updated_at, card_lines) VALUES (?, ?, ?, 'owner', ?, ?) " +
				"ON CONFLICT (merchant_key) DO UPDATE SET kind = excluded.kind, category = excluded.category, set_by = 'owner', updated_at = excluded.updated_at, card_lines = excluded.card_lines",
		)
		.bind(key, rule.kind, rule.category, rule.updated_at, rule.card_lines)
		.run();
	RULES_CACHE.delete(e);
	const lines = await linesCoveredBy(e, key);
	// Only what the owner just said is applied to every line; the rest of the rule stays as the lines have it.
	const now: Pick<PayeeRule, "kind" | "category"> = { kind: set.kind !== undefined ? rule.kind : null, category: set.category !== undefined ? rule.category : null };
	const changed = await writeChanges({ ...e, actor: "owner" }, "payee_rule", lines.map((line) => ({ line, changes: ruleChanges(line, now) })));
	return { rule, changed };
}

/// The look back's "rules" piece: old lines read again under the owner's payee
/// rules, a page of `limit` lines after `after` (by id). A line the owner set one
/// by one after the rule was made keeps his word for that field. Answers the
/// next cursor (null when done) and how many lines changed.
export async function lookBackRules(e: Engine, after: string | null, limit: number): Promise<{ next: string | null; changed: number }> {
	const rows = (
		await e.db
			.prepare("SELECT * FROM lines WHERE id > ? AND state <> 'void' AND merchant_key IS NOT NULL ORDER BY id LIMIT ?")
			.bind(after ?? "", limit)
			.all<LineRow>()
	).results;
	const next = rows.length < limit ? null : rows.at(-1)!.id;
	if (!rows.length) return { next, changed: 0 };
	const rules = await payeeRules(e);
	const kinds = new Map((await loadAccounts(e.db)).map((a) => [a.id, a.kind]));
	const ruled = rows.map((line) => ({ line, rule: ruleForLine(line.merchant_key, isTransferLine(kinds.get(line.account_id), line.merchant_raw, line.kind), rules) })).filter((x): x is { line: LineRow; rule: PayeeRule } => x.rule !== null);
	if (!ruled.length) return { next, changed: 0 };
	const ids = ruled.map((x) => x.line.id);
	const owners = (
		await e.db
			.prepare("SELECT line_id, event, MAX(at) AS at FROM line_events WHERE actor = 'owner' AND event IN ('kind', 'category', 'categorise') AND line_id IN (SELECT value FROM json_each(?)) GROUP BY line_id, event")
			.bind(JSON.stringify(ids))
			.all<{ line_id: string; event: string; at: string }>()
	).results;
	const said = (id: string, event: string) => owners.find((j) => j.line_id === id && j.event === event)?.at ?? null;
	const items = ruled.map(({ line, rule }) => {
		const kindAt = said(line.id, "kind");
		const ownKind = kindAt !== null && kindAt > rule.updated_at;
		const catAt = said(line.id, "categorise");
		const ownCategory = said(line.id, "category") !== null || (catAt !== null && catAt > rule.updated_at);
		return { line, changes: ruleChanges(line, { kind: ownKind ? null : rule.kind, category: rule.category }, ownCategory) };
	});
	const changed = await writeChanges(e, "payee_rule", items);
	return { next, changed };
}

// ------------------------------------------------------------ subscriptions by the owner's hand

/// The charges a the owner-marked subscription is figured from: every purchase of
/// that merchant in that currency in the last two years.
export async function merchantCharges(db: Db, merchantKey: string, currency: string, today: string): Promise<SubLine[]> {
	return (
		await db
			.prepare("SELECT id, kind, state, txn_date, merchant_key, merchant_name, orig_currency, orig_minor FROM lines WHERE merchant_key = ? AND orig_currency = ? AND kind = 'purchase' AND state <> 'void' AND txn_date >= ?")
			.bind(merchantKey, currency, addDays(today, -731))
			.all<SubLine>()
	).results;
}

/// The owner marks a line in 明細 as a subscription (value true, at his cadence)
/// or says its merchant is not one (false). True: that merchant's row at
/// that cadence becomes his (marked_by 'owner', 訂閱中), figured from all its
/// charges, and any other cadence detection had for it is set aside. False:
/// every row of that merchant is set aside (ignored — never proposed again),
/// with a row made for it if detection had none. Returns the subscription id.
export async function markLineSubscription(e: Engine, lineId: string, value: boolean, cadence: Cadence, today: string): Promise<string> {
	const line = await getLine(e.db, lineId);
	if (!line) throw new Refused("no such line");
	if (!line.merchant_key) throw new Refused("this line has no merchant name to follow");
	if (value && (line.kind !== "purchase" || line.state === "void")) throw new Refused("only a purchase can be a subscription");
	const now = e.now();
	if (!value) {
		await e.db.prepare("UPDATE subscriptions SET owner_status = 'ignored', marked_by = NULL, updated_at = ? WHERE merchant_key = ?").bind(now, line.merchant_key).run();
		const row = await e.db.prepare("SELECT id FROM subscriptions WHERE merchant_key = ? ORDER BY (currency = ?) DESC, updated_at DESC LIMIT 1").bind(line.merchant_key, line.orig_currency).first<{ id: string }>();
		if (row) return row.id;
	}
	const sub = ownerSubscription(value ? await merchantCharges(e.db, line.merchant_key, line.orig_currency, today) : [{ ...line, kind: "purchase", orig_minor: Math.abs(line.orig_minor) || 1 }], cadence, today);
	if (!sub) throw new Refused("no charge from this merchant to follow");
	const id = e.newId();
	await e.db.batch([
		e.db
			.prepare(
				"INSERT INTO subscriptions (id, merchant_key, merchant_name, currency, cadence, amount_minor, previous_amount_minor, price_changed_on, first_seen, last_charged, next_renewal, occurrences, status, owner_status, line_ids_json, updated_at, detected_at, marked_by) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
					"ON CONFLICT (merchant_key, currency, cadence) DO UPDATE SET merchant_name = excluded.merchant_name, amount_minor = excluded.amount_minor, previous_amount_minor = excluded.previous_amount_minor, " +
					"price_changed_on = excluded.price_changed_on, first_seen = excluded.first_seen, last_charged = excluded.last_charged, next_renewal = excluded.next_renewal, occurrences = excluded.occurrences, " +
					"status = excluded.status, owner_status = excluded.owner_status, line_ids_json = excluded.line_ids_json, updated_at = excluded.updated_at, marked_by = excluded.marked_by",
			)
			.bind(
				id, sub.merchant_key, sub.merchant_name, sub.currency, cadence, sub.amount_minor, sub.previous_amount_minor, sub.price_changed_on, sub.first_seen, sub.last_charged, sub.next_renewal,
				sub.occurrences, sub.status, value ? "active" : "ignored", JSON.stringify(sub.line_ids), now, now, value ? "owner" : null,
			),
		// His cadence is the one: any other detection had for this merchant is set aside.
		...(value ? [e.db.prepare("UPDATE subscriptions SET owner_status = 'ignored', updated_at = ? WHERE merchant_key = ? AND NOT (currency = ? AND cadence = ?) AND marked_by IS NULL").bind(now, line.merchant_key, line.orig_currency, cadence)] : []),
	]);
	const row = await e.db.prepare("SELECT id FROM subscriptions WHERE merchant_key = ? AND currency = ? AND cadence = ?").bind(sub.merchant_key, sub.currency, cadence).first<{ id: string }>();
	return row!.id;
}

// ------------------------------------------------------------- the wallet (GrabPay)
//
// src/wallet.ts has the rules. Here: the wallet's side of a top-up, the bank or
// card line a top-up the wallet reported came from, the offsets that keep the
// pre-counted balance from being counted twice, and the owner's own wallet spending.
// Everything is safe to repeat: settleWallet works the offsets out from scratch
// each time and changes only what differs.

/// The offset line for `cents` of a wallet purchase paid with pre-counted money.
function offsetLine(e: Engine, wallet: WalletAccount, spend: LineRow, cents: number): LineRow {
	const now = e.now();
	return {
		id: e.newId(),
		account_id: wallet.id,
		kind: "wallet_offset",
		state: "open",
		txn_date: spend.txn_date,
		post_date: null,
		merchant_raw: offsetMerchant(),
		merchant_key: null,
		merchant_name: offsetMerchant(),
		merchant_country: null,
		category: wallet.wallet_precounted_category ?? null,
		orig_currency: wallet.currency,
		orig_minor: -cents,
		bill_currency: wallet.currency,
		bill_minor: -cents,
		bill_status: "exact",
		fee_minor: 0,
		market_rate: null,
		markup: null,
		markup_source: null,
		effective_rate: null,
		observed_markup: null,
		home_minor: -cents,
		home_status: "exact",
		home_rate: null,
		home_set_by: "rules",
		statement_id: null,
		refund_of: null,
		transfer_group: null,
		merged_into: null,
		reimbursable_override: null,
		flag_missed_by_alerts: 0,
		flag_not_on_statement: 0,
		flag_unlinked_refund: 0,
		income_offset: null,
		offset_account_id: null,
		flag_no_rate: 0,
		note: offsetNote(wallet),
		created_by: "rules",
		created_at: now,
		updated_at: now,
		counter_account_id: null,
		owner_ok: null,
		offset_of: spend.id,
	};
}

/// The wallet's offsets, worked out again from its lines (src/wallet.ts
/// planOffsets): one offset per purchase the pre-counted balance pays for,
/// of exactly the part it pays; any other offset is removed (void, never
/// deleted). Returns how many offset lines changed.
export async function settleWallet(e: Engine, wallet: WalletAccount): Promise<number> {
	const rules = { ...e, actor: "rules" as const };
	const rows = (await e.db.prepare("SELECT * FROM lines WHERE account_id = ? AND state <> 'void'").bind(wallet.id).all<LineRow>()).results;
	const want = planOffsets(wallet.wallet_precounted_minor ?? 0, wallet.wallet_since, rows);
	const spends = new Map(rows.filter((l) => l.kind !== "wallet_offset").map((l) => [l.id, l]));
	const kept = new Set<string>();
	let changed = 0;
	for (const o of rows.filter((l) => l.kind === "wallet_offset").sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
		const spend = o.offset_of ? spends.get(o.offset_of) : undefined;
		const cents = spend ? (want.get(spend.id) ?? 0) : 0;
		if (!spend || cents === 0 || kept.has(spend.id)) {
			await changeLine(rules, o, { state: move(o, "void") }, "wallet_offset_void");
			changed++;
			continue;
		}
		kept.add(spend.id);
		if (o.home_minor !== -cents || o.txn_date !== spend.txn_date) {
			await changeLine(rules, o, { orig_minor: -cents, bill_minor: -cents, home_minor: -cents, txn_date: spend.txn_date }, "wallet_offset");
			changed++;
		}
	}
	for (const [id, cents] of want) {
		if (kept.has(id)) continue;
		const line = offsetLine(rules, wallet, spends.get(id)!, cents);
		// OR IGNORE: another run that made this purchase's offset a moment ago wins (one live offset per purchase).
		const [ins] = await e.db.batch([
			insertRow(e.db, "lines", line, true),
			e.db
				.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) SELECT ?, ?, 'rules', 'create', NULL, ? WHERE EXISTS (SELECT 1 FROM lines WHERE id = ?)")
				.bind(line.id, line.created_at, JSON.stringify({ type: "wallet_offset", offset_of: id }), line.id),
		]);
		if (ins!.meta.changes) changed++;
	}
	return changed;
}

/// A wallet top-up leg the ledger made itself (no evidence; created as the
/// mirror of a bank or card line) whose source line is gone — voided, or no
/// longer a transfer: removed too, so the balance never counts money that never came in.
async function voidOrphanLegs(e: Engine, wallet: WalletAccount): Promise<number> {
	const orphans = (
		await e.db
			.prepare(
				"SELECT l.* FROM lines l WHERE l.account_id = ? AND l.kind = 'transfer' AND l.state <> 'void' " +
					"AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.line_id = l.id) " +
					"AND EXISTS (SELECT 1 FROM line_events le WHERE le.line_id = l.id AND le.event = 'create' AND le.after_json LIKE '%wallet_topup_leg%') " +
					"AND NOT EXISTS (SELECT 1 FROM lines p WHERE p.transfer_group = l.transfer_group AND p.id <> l.id AND p.state <> 'void' AND p.kind IN ('transfer', 'card_payment'))",
			)
			.bind(wallet.id)
			.all<LineRow>()
	).results;
	const rules = { ...e, actor: "rules" as const };
	for (const o of orphans) await changeLine(rules, o, { state: move(o, "void"), transfer_group: null }, "wallet_topup_leg_void");
	return orphans.length;
}

/// Each wallet purchase's real cost, worked out again from its lines (src/wallet.ts
/// planCosts: bonus credit, first in first out across top-ups). Writes only what
/// differs — on a wallet whose top-ups had no bonus (GrabPay) nothing ever does —
/// and never a figure the owner set himself. Returns how many lines changed.
export async function costWallet(e: Engine, wallet: WalletAccount): Promise<number> {
	const rules = { ...e, actor: "rules" as const };
	const rows = (await e.db.prepare("SELECT * FROM lines WHERE account_id = ? AND state <> 'void'").bind(wallet.id).all<LineRow>()).results;
	const want = planCosts(wallet.wallet_opening_minor ?? 0, wallet.wallet_opening_paid_minor ?? null, wallet.wallet_since, rows);
	let changed = 0;
	for (const l of rows) {
		const cost = want.get(l.id);
		if (cost === undefined || l.home_set_by === "owner" || l.bill_currency !== homeCurrency() || l.home_minor === cost) continue;
		await changeLine(rules, l, { home_minor: cost, home_status: "exact" }, "wallet_cost");
		changed++;
	}
	return changed;
}

/// The wallet's own bookkeeping after anything touched it: orphan top-up sides
/// removed, real costs (bonus credit), then the offsets (which use the costs).
export async function tidyWallet(e: Engine, wallet: WalletAccount): Promise<void> {
	await voidOrphanLegs(e, wallet);
	await costWallet(e, wallet);
	await settleWallet(e, wallet);
}

/// Tidy every wallet these lines are on or move money to.
export async function tidyWalletsOf(e: Engine, lines: readonly Pick<LineRow, "account_id" | "counter_account_id">[]): Promise<void> {
	if (!lines.length) return;
	const accounts = await loadAccounts(e.db);
	const wallets = accounts.filter(isWallet).filter((w) => lines.some((l) => l.account_id === w.id || l.counter_account_id === w.id));
	for (const w of wallets) await tidyWallet(e, w);
}

/// The wallet's side of a top-up from his bank or card, when the wallet has
/// not reported it itself: made by the rules, paired with its source.
async function topUpLeg(e: Engine, source: LineRow, wallet: WalletAccount, accounts: readonly Account[]): Promise<void> {
	if (source.state === "void" || source.transfer_group !== null || source.kind !== "transfer" || source.bill_minor <= 0 || source.bill_currency !== wallet.currency) return;
	const from = accounts.find((a) => a.id === source.account_id);
	const rules = { ...e, actor: "rules" as const };
	const built = await buildLine(rules, wallet, "transfer", { txn_date: source.txn_date, currency: wallet.currency, amount_minor: -source.bill_minor, merchant_raw: say("wallet.topup_leg_merchant", { from: from?.name ?? source.account_id }) }, { counter_account_id: source.account_id });
	// The shop's usual bonus, when its row names one ("pay 300, get 350"): the credit
	// this top-up gave by default — the money (home) stays what was paid.
	const deal = dealCredit(wallet, source.bill_minor);
	const leg = deal !== null && deal !== source.bill_minor ? { ...built, orig_minor: -deal, bill_minor: -deal, note: `${topUpNote(formatMoney(source.bill_minor, wallet.currency), creditText(deal))}${say("wallet.deal_suffix", { deal: dealText(wallet) ?? "" })}` } : built;
	await e.db.batch([insertRow(e.db, "lines", leg), lineEvent(e.db, leg.id, leg.created_at, "rules", "create", null, { type: "wallet_topup_leg", from: source.id })]);
	await groupPair(rules, source, leg);
}

/// Could this line on his bank or card be the money a wallet top-up came from?
function topUpSourceFits(c: LineRow, leg: Pick<LineRow, "home_minor" | "bill_currency" | "txn_date">, wallet: WalletAccount, kinds: ReadonlyMap<string, Account["kind"]>): boolean {
	const k = kinds.get(c.account_id);
	return (
		(k === "bank" || k === "debit_card" || k === "credit_card") &&
		c.kind === "purchase" &&
		c.state !== "void" &&
		c.transfer_group === null &&
		c.bill_currency === leg.bill_currency &&
		// The money: a wallet side with bonus credit holds more credit (bill) than money (home).
		c.bill_minor === -leg.home_minor &&
		c.txn_date >= wallet.wallet_since &&
		Math.abs(daysBetween(c.txn_date, leg.txn_date)) <= TRANSFER_WINDOW_DAYS &&
		// GrabPay by its own rule; any other wallet by its data rule (migration 0012).
		(wallet.institution === GRAB ? namesGrab(c.merchant_raw) && !isDirectGrabCharge(c.merchant_raw) : fitsTopUpRule({ kind: k }, c.merchant_raw, c.bill_minor, c.txn_date, wallet))
	);
}

/// A bank or card line becomes the top-up it really was: a transfer to the
/// wallet, paired with the wallet's leg. Never a line whose kind the owner set.
async function makeTopUp(e: Engine, source: LineRow, leg: LineRow, wallet: WalletAccount): Promise<void> {
	if ((await ownerKindIds(e.db, [source.id])).has(source.id)) return;
	const rules = { ...e, actor: "rules" as const };
	const moved = await changeLine(rules, source, { kind: "transfer", counter_account_id: wallet.id }, "wallet_topup");
	await groupPair(rules, moved, leg);
}

/// What a new line means for a wallet (afterCreate):
///   1. a top-up from his bank or card (classifyKind said so) that found no
///      wallet leg to pair with: the wallet's leg is made;
///   2. money into the wallet (its own statement or e-receipt said "top up")
///      with no source yet: the Grab line on his bank or card of exactly that
///      amount (±3 days), read as spending, is that top-up;
///   3. a Grab line on his bank or card of exactly a top-up the wallet already
///      reported, still unpaired: it is that top-up.
/// Then the wallet's offsets are worked out again.
async function walletAfterCreate(e: Engine, created: LineRow, accounts: readonly Account[]): Promise<void> {
	const own = accounts.find((a) => a.id === created.account_id);
	const grab = walletOf(accounts, GRAB);
	// Nothing to do with a wallet (the usual case): not one more query.
	if (!isWallet(own) && !isWallet(accounts.find((a) => a.id === created.counter_account_id)) && !(grab && created.kind === "purchase" && namesGrab(created.merchant_raw))) return;
	// As it stands now (pairPayment may have paired it).
	const line = (await getLine(e.db, created.id)) ?? created;
	if (isWallet(own)) {
		if (line.kind === "transfer" && line.bill_minor < 0 && line.transfer_group === null) {
			const kinds = new Map(accounts.map((a) => [a.id, a.kind]));
			const near = (
				await e.db
					.prepare("SELECT * FROM lines WHERE state <> 'void' AND transfer_group IS NULL AND kind = 'purchase' AND bill_minor = ? AND txn_date BETWEEN ? AND ? ORDER BY txn_date, created_at, id")
					.bind(-line.home_minor, addDays(line.txn_date, -TRANSFER_WINDOW_DAYS), addDays(line.txn_date, TRANSFER_WINDOW_DAYS))
					.all<LineRow>()
			).results.filter((c) => topUpSourceFits(c, line, own, kinds));
			near.sort((a, b) => Math.abs(daysBetween(a.txn_date, line.txn_date)) - Math.abs(daysBetween(b.txn_date, line.txn_date)));
			if (near[0]) await makeTopUp(e, near[0], line, own);
		}
		await tidyWallet(e, own);
		return;
	}
	const target = accounts.find((a) => a.id === line.counter_account_id);
	if (line.kind === "transfer" && line.bill_minor > 0 && isWallet(target)) {
		await topUpLeg(e, line, target, accounts);
		await tidyWallet(e, target);
		return;
	}
	const wallet = grab;
	if (wallet && line.kind === "purchase" && line.bill_minor > 0 && line.transfer_group === null && namesGrab(line.merchant_raw)) {
		const kinds = new Map(accounts.map((a) => [a.id, a.kind]));
		const legs = (
			await e.db
				.prepare("SELECT * FROM lines WHERE account_id = ? AND state <> 'void' AND transfer_group IS NULL AND kind = 'transfer' AND home_minor = ? AND txn_date BETWEEN ? AND ? ORDER BY txn_date, created_at, id")
				.bind(wallet.id, -line.bill_minor, addDays(line.txn_date, -TRANSFER_WINDOW_DAYS), addDays(line.txn_date, TRANSFER_WINDOW_DAYS))
				.all<LineRow>()
		).results.filter((leg) => topUpSourceFits(line, leg, wallet, kinds));
		legs.sort((a, b) => Math.abs(daysBetween(a.txn_date, line.txn_date)) - Math.abs(daysBetween(b.txn_date, line.txn_date)));
		if (legs[0]) {
			await makeTopUp(e, line, legs[0], wallet);
			await tidyWallet(e, wallet);
		}
	}
}

/// The owner's word: this bank or card line was money he put into his wallet —
/// `walletId` names which (any prepaid wallet); none given = GrabPay (the
/// connector's older `grabpay_topup`). `credit` (19 Oct 2026): the credit he
/// got for it, in the wallet's minor units ("pay S$200, get 240" → 24000);
/// none = no bonus (credit = what he paid). His word answers 「這次儲值有送嗎？」.
export async function markWalletTopUp(e: Engine, lineId: string, walletId?: string | null, credit?: number | null): Promise<LineRow> {
	const owner = { ...e, actor: "owner" as const };
	const accounts = await loadAccounts(e.db);
	const line = await getLine(e.db, lineId);
	if (!line) throw new Refused("no such line");
	if (line.state === "void") throw new Refused("that line was removed");
	const wallet = walletId ? accounts.find((a) => a.id === walletId) : walletOf(accounts, GRAB);
	if (!isWallet(wallet)) throw new Refused(walletId ? `${walletId} is not one of your wallets` : "there is no GrabPay wallet on the account list");
	if (wallet.active !== 1) throw new Refused(`${wallet.name} is no longer in use`);
	const from = accounts.find((a) => a.id === line.account_id);
	if (!from || (from.kind !== "bank" && from.kind !== "debit_card" && from.kind !== "credit_card")) throw new Refused("only a line on one of your bank accounts or cards can be a top-up of your wallet");
	if (line.bill_minor <= 0) throw new Refused("a top-up is money going out of that account");
	if (line.bill_currency !== wallet.currency) throw new Refused(`${wallet.name} holds ${wallet.currency} only`);
	if (line.txn_date < wallet.wallet_since) throw new Refused(`${wallet.name} is recorded from ${wallet.wallet_since}; top-ups before then stay counted as spending`);
	checkCredit(wallet, line.bill_minor, credit);
	// GrabPay asks no bonus question: only a credit he names changes anything there.
	const asks = wallet.institution !== GRAB || (credit !== null && credit !== undefined);
	// No credit named: the shop's usual deal, if its row has one; else no bonus.
	const got = credit ?? dealCredit(wallet, line.bill_minor);
	if (line.kind === "transfer" && line.counter_account_id === wallet.id) {
		// Already its top-up (the rule made it, or he said so before): only the credit is news.
		if (asks) await setTopUpCredit(e, line.id, got);
		return (await getLine(e.db, line.id))!;
	}
	let moved = line;
	if (line.transfer_group) {
		// Leave whatever pair it was in (never half-paired).
		await writeChanges(owner, "kind", [{ line, changes: { kind: "transfer" } }]);
		moved = (await getLine(e.db, line.id))!;
	}
	moved = await changeLine(owner, moved, { kind: "transfer", counter_account_id: wallet.id, transfer_group: null }, "kind");
	const leg = (
		await e.db
			.prepare("SELECT * FROM lines WHERE account_id = ? AND state <> 'void' AND transfer_group IS NULL AND kind = 'transfer' AND home_minor = ? AND txn_date BETWEEN ? AND ? ORDER BY txn_date, created_at, id LIMIT 1")
			.bind(wallet.id, -line.bill_minor, addDays(line.txn_date, -TRANSFER_WINDOW_DAYS), addDays(line.txn_date, TRANSFER_WINDOW_DAYS))
			.first<LineRow>()
	);
	if (leg) await groupPair(owner, moved, leg);
	else await topUpLeg(owner, moved, wallet, accounts);
	if (asks) await setTopUpCredit(e, line.id, got);
	else await tidyWallet(e, wallet);
	return (await getLine(e.db, line.id))!;
}

/// A credit the owner gives for a top-up: at least what he paid (a bonus adds, it
/// never takes away) and at most MAX_BONUS_RATIO times it (a typo is refused).
function checkCredit(wallet: Pick<Account, "name" | "currency">, paidMinor: number, credit: number | null | undefined): void {
	if (credit === null || credit === undefined) return;
	if (!Number.isInteger(credit) || credit <= 0) throw new Refused(say("wallet.credit_not_number"));
	if (credit < paidMinor) throw new Refused(say("wallet.credit_below_paid", { credit: creditText(credit), paid: formatMoney(paidMinor, wallet.currency) }));
	if (credit > paidMinor * MAX_BONUS_RATIO) throw new Refused(say("wallet.credit_too_big", { credit: creditText(credit), paid: formatMoney(paidMinor, wallet.currency), ratio: MAX_BONUS_RATIO }));
}

/// What the owner's word on a top-up's bonus marks on its wallet side (lines.owner_ok):
/// the 「這次儲值有送嗎？」 question is answered and never asked again.
export const BONUS_ANSWERED = "bonus";

/// The wallet side of a top-up, from either side's id (the bank or card line, or the wallet's own).
async function topUpWalletSide(e: Engine, lineId: string): Promise<{ leg: LineRow; wallet: WalletAccount; paid: number }> {
	const line = await getLine(e.db, lineId);
	if (!line || line.state === "void") throw new Refused("no such line");
	const accounts = await loadAccounts(e.db);
	const own = accounts.find((a) => a.id === line.account_id);
	let leg: LineRow | null = null;
	if (isWallet(own)) leg = line.kind === "transfer" && line.bill_minor < 0 ? line : null;
	else if (line.kind === "transfer" && line.transfer_group) {
		leg = await e.db.prepare("SELECT * FROM lines WHERE transfer_group = ? AND id <> ? AND state <> 'void' AND account_id = ? LIMIT 1").bind(line.transfer_group, line.id, line.counter_account_id).first<LineRow>();
	}
	const wallet = leg ? accounts.find((a) => a.id === leg!.account_id) : null;
	if (!leg || !isWallet(wallet)) throw new Refused("that line is not a top-up of one of your wallets");
	return { leg, wallet, paid: -leg.home_minor };
}

/// The owner's answer to 「這次儲值有送嗎？」 for one top-up (either side's id):
/// `credit` = the credit he got (minor units), or null = no bonus (credit =
/// what he paid). The wallet's balance and every meal's real cost follow.
export async function setTopUpCredit(e: Engine, lineId: string, credit: number | null): Promise<LineRow> {
	const { leg, wallet, paid } = await topUpWalletSide(e, lineId);
	checkCredit(wallet, paid, credit);
	const got = credit ?? paid;
	const owner = { ...e, actor: "owner" as const };
	const ok = new Set((leg.owner_ok ?? "").split(",").filter(Boolean)).add(BONUS_ANSWERED);
	const deal = dealCredit(wallet, paid) === got ? dealText(wallet) : null;
	const note = got === paid ? null : `${topUpNote(formatMoney(paid, wallet.currency), creditText(got))}${deal ? say("wallet.deal_suffix", { deal }) : ""}`;
	await changeLine(owner, leg, { orig_minor: -got, bill_minor: -got, owner_ok: [...ok].sort().join(","), note }, "wallet_topup_credit");
	await tidyWallet(e, wallet);
	return (await getLine(e.db, leg.id))!;
}

/// The owner's own word for money spent from his wallet (the connector's
/// ledger_add_cash with account "grabpay", "sample-bistro", … any wallet). If
/// Grab's own mail already put that purchase in the ledger (same amount, same
/// or next day), his word joins that line instead of adding a second one. On a
/// wallet only the owner's word fills (no mail, no statements), a purchase that takes
/// the balance below zero is still recorded but flagged for a look: he may not
/// have told the ledger about a top-up.
async function addWalletSpend(e: Engine, wallet: WalletAccount, c: CashIn): Promise<LineRow> {
	return (await walletSpend(e, wallet, c, null)).line;
}

/// A wallet spend a shop's SMS reported (src/wallet-sms.ts), recorded as
/// The owner's word is: in the wallet's credit, its real cost worked out by the
/// wallet. It joins a line the owner already told for the same credit (same or
/// next day) that no SMS has joined yet; otherwise it is a line of its own.
export async function addWalletSmsSpend(e: Engine, wallet: WalletAccount, c: CashIn, fingerprint: string): Promise<{ line: LineRow; joined: boolean }> {
	return walletSpend(e, wallet, c, { fingerprint });
}

async function walletSpend(e: Engine, wallet: WalletAccount, c: CashIn, sms: { fingerprint: string } | null): Promise<{ line: LineRow; joined: boolean }> {
	if (c.currency !== wallet.currency) throw new Refused(`${wallet.name} holds ${wallet.currency} only`);
	if (c.home_minor !== null && c.home_minor !== undefined && c.home_minor !== c.amount_minor) throw new Refused(`${wallet.name} is in ${wallet.currency}: give the amount only (what the shop deducted from the card; the ledger works out its real cost)`);
	if (c.txn_date < wallet.wallet_since) throw new Refused(`${wallet.name} is recorded from ${wallet.wallet_since}; spending before then was already counted when the wallet was topped up`);
	// The owner's word, or the reader's reading of the shop's SMS.
	const owner = sms ? e : { ...e, actor: "owner" as const };
	const type = sms ? ("sms" as const) : ("manual" as const);
	const kind: LineKind = c.amount_minor < 0 ? "refund" : "purchase";
	const ids = new Set([wallet.id]);
	const fits = candidateFits({ type, account_ids: ids, kind, currency: c.currency, amount_minor: c.amount_minor, txn_date: c.txn_date, merchant_key: merchantKey(c.merchant, e.aliases) }, await candidatesNear(e.db, ids, c.txn_date)).filter((f) => f.days <= 1);
	const now = e.now();
	const evidenceRow = (lineId: string): Evidence => ({
		id: e.newId(),
		type,
		line_id: lineId,
		message_id: null,
		statement_id: null,
		fingerprint: sms ? sms.fingerprint : manualFingerprint(e.newId()),
		institution: wallet.institution,
		last4: null,
		txn_date: c.txn_date,
		txn_time: null,
		post_date: null,
		currency: c.currency,
		amount_minor: c.amount_minor,
		bill_currency: null,
		bill_minor: null,
		merchant_raw: c.merchant,
		merchant_country: null,
		kind_hint: null,
		details_json: null,
		created_at: now,
	});
	if (fits.length) {
		const best = fits[0]!;
		// An SMS never asks: each SMS is one use of the card, deduplicated before it got here.
		if (!sms && best.merchant < STRONG_MERCHANT && fits.length > 1) {
			throw new Refused(`${fits.length} ${wallet.name} lines of that amount around that day are already in the ledger (${fits.map((f) => `${f.line.id}: ${f.line.txn_date} ${f.line.merchant_name ?? f.line.merchant_raw ?? ""}`).join("; ")}); nothing was added. If this is one of them, nothing needs adding; if it is another purchase, give a different date or a clearer merchant name`);
		}
		const ev = evidenceRow(best.line.id);
		await e.db.batch([insertRow(e.db, "evidence", ev), lineEvent(e.db, best.line.id, now, owner.actor, "evidence", null, { evidence_id: ev.id, type })]);
		// The owner's own category stays; an SMS only fills one that is missing.
		const take = c.category && c.category !== best.line.category && (!sms || !best.line.category);
		const joined = take ? await changeLine(owner, best.line, { category: c.category }, "category") : best.line;
		await tidyWallet(e, wallet);
		return { line: (await getLine(e.db, joined.id)) ?? joined, joined: true };
	}
	const id = e.newId();
	const line = await buildLine(owner, wallet, kind, { txn_date: c.txn_date, currency: c.currency, amount_minor: c.amount_minor, merchant_raw: c.merchant }, { id, category: c.category ?? null, note: c.note ?? null, created_by: owner.actor });
	await e.db.batch([insertRow(e.db, "lines", line), insertRow(e.db, "evidence", evidenceRow(id)), lineEvent(e.db, id, line.created_at, owner.actor, "create", null, { type })]);
	await tidyWallet(e, wallet);
	// Only a wallet that knows nothing but the owner's word (Sample Bistro): GrabPay's own mail and
	// daily statement keep its balance, and a top-up there may simply not have arrived yet.
	if (kind === "purchase" && toldOnly(wallet)) await flagIfOverdrawn(e, wallet, id);
	return { line: (await getLine(e.db, id))!, joined: false };
}

/// The note on a wallet purchase that took the balance below zero.
export const overdrawnNote = (wallet: Pick<Account, "name">, balance: number, currency: string) => say("wallet.overdrawn_note", { name: wallet.name, balance: formatMoney(balance, currency) });

/// His word stands, but a balance below zero is flagged for a look (needs_review).
async function flagIfOverdrawn(e: Engine, wallet: WalletAccount, lineId: string): Promise<void> {
	const balance = (await walletStates(e.db, [wallet])).get(wallet.id)?.balance.minor ?? 0;
	if (balance >= 0) return;
	const line = await getLine(e.db, lineId);
	if (!line || line.state === "void") return;
	const note = overdrawnNote(wallet, balance, wallet.currency);
	await changeLine({ ...e, actor: "rules" as const }, line, { state: move(line, "flag_review"), note: line.note ? `${line.note}\n${note}` : note }, "wallet_overdrawn");
}

/// What an adjustment line made from a shop's SMS balance is called (in the
/// owner's language when it is made; nothing matches on it).
export const smsAdjustMerchant = () => say("wallet.sms_adjust_merchant");

/// The owner's 「用簡訊的餘額」: one line that brings the wallet's balance to what the
/// shop's SMS said. `creditOut` > 0: credit was used that nobody told the
/// ledger — a purchase (in the wallet's category), costed like any meal.
/// `creditOut` < 0: the shop holds more credit than the ledger knew — credit
/// in that cost nothing (a "rebate" of S$0.00): the balance matches, spending
/// is unchanged, and later meals are costed with it as free credit.
export async function addWalletAdjustment(e: Engine, wallet: WalletAccount, date: string, creditOut: number, note: string, category: string | null): Promise<LineRow> {
	if (!Number.isInteger(creditOut) || creditOut === 0) throw new Refused("nothing to adjust");
	const owner = { ...e, actor: "owner" as const };
	const txnDate = date < wallet.wallet_since ? wallet.wallet_since : date;
	const kind: LineKind = creditOut > 0 ? "purchase" : "rebate";
	const built = await buildLine(owner, wallet, kind, { txn_date: txnDate, currency: wallet.currency, amount_minor: creditOut, merchant_raw: smsAdjustMerchant() }, { category: creditOut > 0 ? category : null, note, created_by: "owner" });
	const line = creditOut > 0 ? built : { ...built, home_minor: 0 };
	const ev: Evidence = {
		id: e.newId(),
		type: "manual",
		line_id: line.id,
		message_id: null,
		statement_id: null,
		fingerprint: manualFingerprint(e.newId()),
		institution: wallet.institution,
		last4: null,
		txn_date: txnDate,
		txn_time: null,
		post_date: null,
		currency: wallet.currency,
		amount_minor: creditOut,
		bill_currency: null,
		bill_minor: null,
		merchant_raw: smsAdjustMerchant(),
		merchant_country: null,
		kind_hint: null,
		details_json: null,
		created_at: line.created_at,
	};
	await e.db.batch([insertRow(e.db, "lines", line), insertRow(e.db, "evidence", ev), lineEvent(e.db, line.id, line.created_at, "owner", "create", null, { type: "wallet_sms_adjust" })]);
	await tidyWallet(e, wallet);
	return (await getLine(e.db, line.id))!;
}
