/// The work queue: one Gmail message per unit, alerts
/// and receipts before statements, each unit small enough to finish inside a
/// tick's budget — and safe to cut off anywhere, because every write is
/// idempotent (the messages row is INSERT OR IGNORE, evidence dedups on its
/// fingerprint, a statement import resumes) and a paid reading is kept in
/// `work.payload_json` (figures only) so it is never paid for twice.
///
///   alert     a playbook pattern if one fits (free), else the model:
///             daily reader → senior if unsure → the owner (escalation) if still unsure
///   receipt   the model, same ladder
///   statement each PDF unlocked with the owner's secrets, read by the model,
///             checked locally (opening ± lines = closing), re-read by the
///             senior model if it does not add up, then imported in chunks
///   failures  retried with backoff (10 min × 2^attempts); the fifth failure
///             parks it as 'failed' with an escalation — never dropped
///
/// Today's mail first (13 Oct 2026): `todaysMail` reads the bank
/// alerts the mail check just queued at the very start of every tick, before
/// any heavy work; a statement the owner uploaded or one the look back reads again
/// is paid from its own approval (pot "catchup"), never the daily allowance;
/// and `mailWatch` raises an alarm when bank mail waits more than two hours.

import { addDays } from "../../src/dates";
import { dayStart, home, localClockText } from "../../src/home";
import { isOwnSummary, emailAddress } from "../../src/dedup";
import { escalateStmt, ingestEvidence, ingestStatement, loadAccounts, prepareReread, STATEMENT_COST, type Engine, type EvidenceIn } from "../../src/engine";
import { applyAlertPattern, defaultPdfSecretName, type Playbook } from "../../src/playbook";
import type { PlaybookHead } from "../../src/playbook-store";
import type { Account, Actor } from "../../src/types";
import type * as z from "zod/v4";
import { builtInAlert, walletAuthenticated } from "./banks";
import { fixedCategories } from "./categorise";
import { walletOf, type WalletAccount } from "../../src/wallet";
import { BudgetExhausted } from "./budget";
import { ask, STOPS_THE_RUN } from "./claude";
import { readByTask, readerHolds, readerStuckReason, type AskOpts } from "./reader";
import { secretNamed } from "./env";
import { GmailError, type Mail } from "./gmail";
import { DEFAULT_FROM } from "./mail";
import { unlockWithAny } from "./pdf";
import { isUploadId, UPLOAD_EXPIRED, UPLOAD_KEEP_MS, WAIT_PDF_PASSWORD, WAIT_PICK_ACCOUNT, type UploadResult } from "../../src/upload-status";
import { forgetUpload, loadUpload, type Via } from "./uploads";
import { PDF_ALARM_PREFIX, pdfLocksDue, refreshPdfLocks, withLockNote } from "./pdf-locks";
import { alertFromAnswer, alertFromPattern, classify, grabFromAnswer, grabPrompt, noiseReason, oneBillNote, unknownBankSender, unverifiedBank, emailPrompt, institutionOf, receiptFromAnswer, receivedDate, ignoreSubjects, senderMatches, statementPrompt, statementsFromAnswer, systemPrompt, type ReadStatement } from "./read";
import { AlertSchema, GrabSchema, ReceiptSchema, StatementSchema } from "./schemas";
import { mailFlows, todaysMailPhase, type MailCheck } from "./pull";
import { silenceKey } from "./silence";
import type { BackfillState } from "./backfill";
import type { Pot, Step, Tick } from "./tick";

/// Queries kept in hand before starting an alert or receipt.
export const UNIT_COST = 45;
export const MAX_ATTEMPTS = 5;
export const RETRY_BASE_MS = 10 * 60_000;
/// A unit that needs the model while it is paused or capped waits this long.
export const MODEL_WAIT_MS = 30 * 60_000;
/// A statement whose PDF password is missing or wrong is tried again daily.
export const PASSWORD_WAIT_MS = 24 * 3_600_000;

export interface WorkRow {
	gmail_id: string;
	source: "daily" | "backfill" | "owner_upload";
	month: string | null;
	kind: string | null;
	stage: string;
	attempts: number;
	not_before: string | null;
	park_until_month: string | null;
	payload_json: string | null;
}

interface Payload {
	evidence?: EvidenceIn;
	ignored?: boolean;
	statements?: ReadStatement[];
	next?: number;
	/// Round 2: a statement already imported, read again (the look back's "reread"
	/// piece): its pieces are matched to what is stored before the import resumes.
	reread?: boolean;
	prepared?: boolean;
	/// What the import did with each statement (an upload's status shows it).
	results?: UploadResult[];
}

/// A statement PDF the owner uploaded himself (uploads.ts): no Gmail, his word for
/// who sent it, and maybe his word for which card it is.
interface Upload {
	bytes: Uint8Array;
	account_id: string | null;
	via: Via;
}

const UPLOAD_ORIGIN: Record<Via, string> = {
	page: "a PDF the owner uploaded himself on his ledger page (he downloaded it from his bank's app or website)",
	share: "a PDF the owner sent himself from his iPhone's Share Sheet (from his bank's app)",
};

export type Tier = "daily" | "senior";

export function engineFor(t: Tick, head: PlaybookHead | null, actor: Actor): Engine {
	return {
		db: t.db,
		now: () => t.iso(),
		newId: () => t.deps.newId(),
		ownNames: head?.body.own_names ?? [],
		aliases: head?.body.merchant_aliases ?? [],
		actor,
	};
}

export function modelFor(t: Tick, tier: Tier): string | undefined {
	return tier === "senior" ? t.env.LEDGER_MODEL_SENIOR : t.env.LEDGER_MODEL_DAILY;
}

type Read<T> = { ok: true; data: T; tier: Tier } | { ok: false; why: "blocked"; pending?: true } | { ok: false; why: "failed"; message: string };

/// One model reading. "blocked" = the model cannot be asked right now (no
/// key, paused, over the cap): the unit waits, nothing is counted against it.
///
/// In subscription mode (LEDGER_READER, reader.ts) no model is called: the
/// same system prompt, content and schema become a reading task, and the
/// answer the owner's Claude routine gives back is returned here exactly as an API
/// answer would be ("blocked" with `pending` until then).
export async function readWith<S extends z.ZodType>(t: Tick, tier: Tier, task: Parameters<typeof systemPrompt>[0], user: string, schema: S, maxTokens: number, opts: AskOpts = {}): Promise<Read<z.infer<S>>> {
	if (t.subscription) {
		const r = await readByTask(t, tier, task, systemPrompt(task, await t.head()), user, schema, opts);
		if (r.ok) return { ok: true, data: r.data, tier };
		return r.why === "pending" ? { ok: false, why: "blocked", pending: true } : r;
	}
	const model = modelFor(t, tier);
	if (!t.modelReady(model)) return { ok: false, why: "blocked" };
	const head = await t.head();
	const cap = await t.cap();
	const paid = cap.calls;
	const a = await ask(t.svc.claude!, { model, system: systemPrompt(task, head), user, schema, maxTokens, effort: tier === "senior" ? "high" : task === "statement" ? "medium" : "low", cap });
	// Paid for (whatever the answer): written down before anything else happens.
	if (cap.calls > paid) await t.recordSpend(a.model, a.usd);
	if (a.ok || a.failure !== "over_cap") t.count(`calls_${tier}`);
	if (a.ok) {
		t.modelSucceeded();
		return { ok: true, data: a.data, tier };
	}
	if (STOPS_THE_RUN.has(a.failure) || a.failure === "unavailable") {
		t.modelFailure(a.failure);
		return { ok: false, why: "blocked" };
	}
	return { ok: false, why: "failed", message: `${a.failure}: ${a.message}` };
}

/// Does turning a reading into money work? An amount the model copied as
/// "S$12.00", "12.00 CR" or "1.234,50" cannot be: that reading is UNFIT, like
/// one that missed the schema — never an error to retry (and pay for) again.
export function converts(f: () => unknown): boolean {
	try {
		f();
		return true;
	} catch {
		return false;
	}
}
/// What work.error says of an unfit figure: never the email's own text.
export const UNFIT_FIGURES = "unfit: a figure in the reading could not be read as an amount or date";

/// Daily reader first (senior in the backfill); "unsure", a failed answer or
/// an unfit one (its figures do not convert) goes up to the senior reader
/// once, and is then final.
async function readLadder<S extends z.ZodType>(t: Tick, row: WorkRow, task: "alert" | "receipt", user: string, schema: S, maxTokens: number, sure: (d: z.infer<S>) => boolean, fits: (d: z.infer<S>) => boolean): Promise<Read<z.infer<S>>> {
	let tier: Tier = row.source === "backfill" ? "senior" : "daily";
	for (;;) {
		const r = await readWith(t, tier, task, user, schema, maxTokens);
		if (r.ok && sure(r.data) && fits(r.data)) return r;
		if (!r.ok && r.why === "blocked") return r;
		if (tier === "senior") return r.ok ? { ok: false, why: "failed", message: fits(r.data) ? "the senior reader was unsure too" : UNFIT_FIGURES } : r;
		tier = "senior";
	}
}

function messageRow(t: Tick, m: Mail, classification: string) {
	return t.db
		.prepare("INSERT OR IGNORE INTO messages (gmail_id, thread_id, from_addr, subject, received_at, classification, processed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
		.bind(m.id, m.thread_id, emailAddress(m.from), m.subject.slice(0, 300), m.received_at, classification, t.iso());
}

function setWork(t: Tick, id: string, changes: Record<string, unknown>) {
	const cols = Object.keys(changes);
	return t.db.prepare(`UPDATE work SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE gmail_id = ?`).bind(...Object.values(changes), t.iso(), id);
}

async function finish(t: Tick, m: Mail, classification: string) {
	await t.db.batch([messageRow(t, m, classification), setWork(t, m.id, { stage: "done", kind: classification, error: null })]);
	t.count(`done_${classification}`);
}

/// The unit failed: retry later with backoff; the fifth time, the owner hears of it.
async function failed(t: Tick, row: WorkRow, error: string, final = false) {
	const attempts = row.attempts + 1;
	const engine = engineFor(t, null, "rules");
	if (final || attempts >= MAX_ATTEMPTS) {
		// An upload that failed is the owner's to see in 待確認 (with the reason), not
		// the escalation model's — and its file is deleted with the failure.
		await t.db.batch([
			setWork(t, row.gmail_id, { stage: "failed", attempts, error: error.slice(0, 500) }),
			isUploadId(row.gmail_id)
				? forgetUpload(t.db, row.gmail_id)
				: escalateStmt(engine, "unknown_format", row.gmail_id, `An email (${row.kind ?? "not yet sorted"}) could not be read: ${error.slice(0, 300)}`),
		]);
		t.count("failed");
	} else {
		const wait = RETRY_BASE_MS * 2 ** attempts;
		await setWork(t, row.gmail_id, { attempts, not_before: new Date(t.now().getTime() + wait).toISOString(), error: error.slice(0, 500) }).run();
		t.count("retry");
	}
}

async function waitForModel(t: Tick, row: WorkRow, kind: string | null) {
	await setWork(t, row.gmail_id, { kind, attempts: row.attempts, not_before: new Date(t.now().getTime() + MODEL_WAIT_MS).toISOString() }).run();
	t.count("waiting_for_model");
}

/// The evidence is known: record the message, keep the reading, ingest, done.
async function ingestRead(t: Tick, row: WorkRow, m: Mail, kind: "alert" | "receipt", ev: EvidenceIn, actor: Actor) {
	// A bank's own alert arrived: it has not gone quiet (silence.ts).
	if (kind === "alert" && ev.authenticated && ev.institution) t.clear(silenceKey(ev.institution));
	const payload: Payload = { evidence: ev };
	await t.db.batch([messageRow(t, m, kind), setWork(t, row.gmail_id, { kind, payload_json: JSON.stringify(payload) })]);
	const r = await ingestEvidence(engineFor(t, await t.head(), actor), ev);
	t.count(`evidence_${r.status}`);
	await setWork(t, row.gmail_id, { stage: "done", error: null }).run();
	t.count(`done_${kind}`);
}

async function alertUnit(t: Tick, row: WorkRow, m: Mail): Promise<void> {
	const head = await t.head();
	const from = emailAddress(m.from);
	// Only an authenticated bank alert may teach a card its number (engine.ts).
	const bank = t.banks().authenticated(from, m.auth ?? []);
	const authenticated = bank !== null;
	const email = { from, subject: m.subject, body: m.text, received_date: receivedDate(m) };
	// A format the ledger knows by heart (banks.ts) first, then the playbook's learned patterns.
	const builtIn = builtInAlert(bank, email);
	if (builtIn) {
		t.count(builtIn.pattern_id);
		return ingestRead(t, row, m, "alert", { ...alertFromPattern(builtIn, m.id), authenticated }, "rules");
	}
	const pattern = applyAlertPattern(head?.body.alert_patterns ?? [], email);
	if (pattern) return ingestRead(t, row, m, "alert", { ...alertFromPattern(pattern, m.id), authenticated }, "rules");
	// A new bank alert may use the whole daily allowance (the mail reserve too).
	const r = await t.withLane(row.source === "daily" ? "mail" : "other", () => readLadder(t, row, "alert", emailPrompt(m), AlertSchema, 4000, (d) => d.confidence === "sure", (d) => !d.is_transaction || converts(() => alertFromAnswer(d, m.id, null))));
	if (!r.ok) return r.why === "blocked" ? waitForModel(t, row, "alert") : failed(t, row, r.message, true);
	if (!r.data.is_transaction) return finish(t, m, "ignored");
	// The bank is the one Gmail vouched for, never the model's say (it may name another bank, or "other").
	const ev = { ...alertFromAnswer(r.data, m.id, bank ?? institutionOf(from, head?.body ?? null, t.banks())), authenticated };
	if (r.tier === "senior") {
		// The senior reader's own reading: what a pattern for this sender must reproduce (learn.ts).
		const { note: _note, confidence: _c, ...figures } = r.data;
		await t.db
			.prepare("INSERT OR IGNORE INTO alert_samples (gmail_id, sender, reading_json, created_at) VALUES (?, ?, ?, ?)")
			.bind(m.id, from, JSON.stringify({ ...figures, subject: m.subject.slice(0, 300), received_date: receivedDate(m) }), t.iso())
			.run();
	}
	return ingestRead(t, row, m, "alert", ev, r.tier);
}

export const DEFAULT_RECEIPTS_PER_DAY = 30;
interface ReceiptsRead {
	day: string;
	n: number;
}

/// Anyone can email the owner an "invoice". So, in the daily reading, receipts
/// (all mail that is not a bank's own) come AFTER the bank's: one seen for the
/// first time is only marked a receipt and waits for a later tick, where it is
/// queued behind every unsorted email and bank alert (due()). And at most
/// LEDGER_RECEIPTS_PER_DAY of them (default 30) go to the model per day
/// (the owner's day); the rest wait for the next day — junk cannot burn the day's cap.
async function receiptGate(t: Tick, row: WorkRow): Promise<"read" | "wait"> {
	if (row.source !== "daily") return "read";
	if (row.kind !== "receipt") {
		await setWork(t, row.gmail_id, { kind: "receipt" }).run();
		t.count("receipt_after_bank_mail");
		return "wait";
	}
	// Subscription mode: a receipt already handed to the reader was counted when
	// it was (its unit comes back here while the reader has not answered yet).
	if (t.subscription && (await t.db.prepare("SELECT 1 AS x FROM reading_tasks WHERE origin = ? LIMIT 1").bind(row.gmail_id).first())) return "read";
	const limit = Math.max(0, Math.floor(Number(t.env.LEDGER_RECEIPTS_PER_DAY ?? "") || DEFAULT_RECEIPTS_PER_DAY));
	const today = t.today();
	const prev = t.get<ReceiptsRead>("receipts_read");
	const n = prev?.day === today ? prev.n : 0;
	if (n >= limit) {
		const tomorrow = dayStart(addDays(today, 1)).toISOString();
		await setWork(t, row.gmail_id, { not_before: tomorrow }).run();
		t.count("receipt_over_daily_limit");
		return "wait";
	}
	// Counted BEFORE the model is paid, so a stopped tick cannot under-count.
	await t.put("receipts_read", { day: today, n: n + 1 }).run();
	return "read";
}

async function receiptUnit(t: Tick, row: WorkRow, m: Mail): Promise<"stop" | void> {
	if ((await receiptGate(t, row)) === "wait") return;
	// Grab's own mail (Gmail vouched for grab.com): the GrabPay wallet's source of truth.
	const from = emailAddress(m.from);
	if (walletAuthenticated(from, m.auth ?? []) === "grab") {
		t.clear("wallet_unverified:GRAB");
		const wallet = walletOf(await loadAccounts(t.db), "grab");
		if (wallet) return grabUnit(t, row, m, wallet);
	} else if (/(^|[@.])grab\.com$/.test(from)) {
		// Says it is Grab's but Gmail did not vouch for it: read only as an ordinary
		// receipt (it can add nothing) — and the owner hears of it, in case Grab's real
		// mail is failing the check and his wallet lines are not arriving.
		t.count("wallet_mail_unverified");
		t.raise("wallet_unverified:GRAB", "An email that says it is from Grab did not pass Gmail's check that it really came from Grab, so the ledger read it only as an ordinary receipt (it cannot add anything to your GrabPay wallet). If Grab really emails you this way, tell your developer; otherwise it was probably a fake and you can ignore it.");
	}
	const r = await readLadder(t, row, "receipt", emailPrompt(m), ReceiptSchema, 6000, (d) => d.confidence === "sure" || !d.is_receipt, (d) => !d.is_receipt || converts(() => receiptFromAnswer(d, m)));
	if (!r.ok) return r.why === "blocked" ? waitForModel(t, row, "receipt") : failed(t, row, r.message, true);
	if (!r.data.is_receipt) return finish(t, m, "ignored");
	return ingestRead(t, row, m, "receipt", receiptFromAnswer(r.data, m), r.tier);
}

/// A Grab e-receipt or the GrabPay Wallet transaction statement (
/// 14 Oct 2026), from mail Gmail vouched for as Grab's own. What it may do is
/// fixed in code (read.ts grabFromAnswer): lines on the GrabPay wallet only —
/// an order paid by card stays an ordinary receipt. A PDF it carries (a
/// statement may come as one) is opened with LEDGER_PDF_PW_GRAB when locked.
async function grabUnit(t: Tick, row: WorkRow, m: Mail, wallet: WalletAccount): Promise<"stop" | void> {
	const pages: string[] = [];
	if (m.pdfs.length) {
		if (t.pdfsLeft < m.pdfs.length) return "stop"; // the CPU guard: next tick
		t.pdfsLeft -= m.pdfs.length;
		const pw = pdfPasswords(t, wallet.institution, [wallet.id], await t.head());
		for (const pdf of m.pdfs) {
			const text = await unlockWithAny(await t.svc.gmail!.attachment(m.id, pdf.attachment_id), pw.values);
			if (!text.ok) {
				if (text.reason === "wrong_password" || text.reason === "needs_password") {
					const payload_json = withLockNote(row.payload_json, pw.values.length ? "wrong_password" : "no_password");
					await t.db.batch([messageRow(t, m, "receipt"), setWork(t, row.gmail_id, { kind: "receipt", stage: "waiting", not_before: new Date(t.now().getTime() + PASSWORD_WAIT_MS).toISOString(), error: WAIT_PDF_PASSWORD, payload_json })]);
					// The warning names every GrabPay bill still locked, this one included (pdf-locks.ts).
					await refreshLocks(t, await loadAccounts(t.db));
					t.count("waiting_for_password");
					return;
				}
				t.count("grab_pdf_unreadable");
				continue; // the email's own text is still read
			}
			await pdfOpened(t, row, () => loadAccounts(t.db));
			pages.push(...text.pages);
		}
	}
	const categories = fixedCategories(t.env);
	const r = await readLadder(t, row, "receipt", grabPrompt(m, pages), GrabSchema, 12000, (d) => d.confidence === "sure" || !d.is_money, (d) => converts(() => grabFromAnswer(d, m, wallet, categories)));
	if (!r.ok) return r.why === "blocked" ? waitForModel(t, row, "receipt") : failed(t, row, r.message, true);
	const action = grabFromAnswer(r.data, m, wallet, categories);
	t.count(`grab_${action.kind}`);
	if (action.kind === "ignored") return finish(t, m, "ignored");
	if (action.kind === "evidence") return ingestRead(t, row, m, action.as, action.ev, r.tier);
	const payload: Payload = { statements: action.read, next: 0 };
	await t.db.batch([messageRow(t, m, "statement"), setWork(t, row.gmail_id, { kind: "statement", stage: "ingest", payload_json: JSON.stringify(payload), error: null })]);
	return ingestUnit(t, { ...row, kind: "statement", stage: "ingest", payload_json: JSON.stringify(payload) });
}

/// The secrets to try for a bank's PDFs: each of its accounts' own (and its
/// `_2`, for a card whose older statements used another password — HSBC's
/// before July 2026), the playbook's named one, then the bank's default
/// (LEDGER_PDF_PW_<BANK>).
export function pdfPasswords(t: Tick, institution: string, accountIds: readonly string[], head: PlaybookHead | null): { names: string[]; values: string[] } {
	const names = [
		...accountIds.flatMap((id) => [defaultPdfSecretName(id), `${defaultPdfSecretName(id)}_2`]),
		...(head?.body.senders.statements.filter((s) => s.institution === institution && s.password_secret).map((s) => s.password_secret!) ?? []),
		defaultPdfSecretName(institution),
	];
	const unique = [...new Set(names)];
	return { names: unique, values: unique.map((n) => secretNamed(t.env, n)).filter((v): v is string => !!v) };
}

/// Rebuild the PDF-password warnings from the bills still locked (pdf-locks.ts).
export async function refreshLocks(t: Tick, accounts: readonly Account[]): Promise<void> {
	const head = await t.head();
	await refreshPdfLocks(t, accounts, (institution, ids) => pdfPasswords(t, institution, ids, head).values.length > 0);
}

/// A PDF of this row opened. If the row was waiting on a password it no longer
/// is, and the bank's warning is rebuilt without it (it goes once no bill of
/// that bank is left locked). A bill that was never locked changes nothing: a
/// NEWER bill opening never clears the warning about an older one.
async function pdfOpened(t: Tick, row: WorkRow, accounts: () => Promise<readonly Account[]>): Promise<void> {
	if (row.stage !== "waiting") return;
	const r = await t.db.prepare("UPDATE work SET error = NULL, updated_at = ? WHERE gmail_id = ? AND error = ?").bind(t.iso(), row.gmail_id, WAIT_PDF_PASSWORD).run();
	if (!r.meta.changes) return;
	if ([...t.alarms.keys()].some((k) => k.startsWith(PDF_ALARM_PREFIX))) await refreshLocks(t, await accounts());
}

/// Every PDF secret the ledger has, for an upload whose bank is not known yet.
function everyPdfPassword(t: Tick, accounts: readonly Account[], head: PlaybookHead | null): { names: string[]; values: string[] } {
	const banks = new Set([...accounts.filter((a) => a.kind === "credit_card" || a.kind === "bank").map((a) => a.institution), ...(head?.body.senders.statements.map((s) => s.institution) ?? [])]);
	const names: string[] = [];
	for (const bank of banks) names.push(...pdfPasswords(t, bank, accounts.filter((a) => a.institution === bank && (a.kind === "credit_card" || a.kind === "bank")).map((a) => a.id), head).names);
	const unique = [...new Set(names)];
	return { names: unique, values: [...new Set(unique.map((n) => secretNamed(t.env, n)).filter((v): v is string => !!v))] };
}

async function statementUnit(t: Tick, row: WorkRow, m: Mail, reread = false, upload: Upload | null = null): Promise<"stop" | void> {
	const head = await t.head();
	const from = emailAddress(m.from);
	const accounts = await loadAccounts(t.db);
	// An upload: the bank is the card the owner named, or not known until it is read.
	const picked = upload?.account_id ? (accounts.find((a) => a.id === upload.account_id) ?? null) : null;
	const institution = upload ? (picked?.institution ?? null) : (institutionOf(from, head?.body ?? null, t.banks()) ?? "other");
	const own = institution ? accounts.filter((a) => a.institution === institution && (a.has_statements === 1 || a.id === picked?.id)).map((a) => a.id) : [];
	const senderAccount = upload ? (picked?.id ?? null) : (head?.body.senders.statements.find((s) => senderMatches(s.from, from))?.account_id ?? null);
	const read: ReadStatement[] = [];
	const unknown: string[] = [];
	const skipped: string[] = []; // PDFs set aside: no text, or not locked
	let counted = false;
	let waiting = false; // subscription mode: a PDF's reading is with the reader
	let opened = false; // a PDF of it opened (pdfOpened has been told)
	if (t.pdfsLeft < m.pdfs.length) return "stop"; // the CPU guard: next tick
	t.pdfsLeft -= m.pdfs.length;
	for (const pdf of m.pdfs) {
		const bytes = upload ? upload.bytes : await t.svc.gmail!.attachment(m.id, pdf.attachment_id);
		const pw = institution ? pdfPasswords(t, institution, own, head) : everyPdfPassword(t, accounts, head);
		const text = await unlockWithAny(bytes, pw.values);
		if (!text.ok) {
			if (text.reason === "wrong_password" || text.reason === "needs_password") {
				const payload_json = withLockNote(row.payload_json, pw.values.length ? "wrong_password" : "no_password");
				await t.db.batch([messageRow(t, m, "statement"), setWork(t, row.gmail_id, { kind: "statement", stage: "waiting", not_before: new Date(t.now().getTime() + PASSWORD_WAIT_MS).toISOString(), error: WAIT_PDF_PASSWORD, payload_json })]);
				// The bank's warning names every bill of it still locked, this one included
				// (pdf-locks.ts). An upload from a bank not known yet raises no bank's
				// warning: 待確認 asks the owner which card it is.
				if (institution) await refreshLocks(t, accounts);
				t.count("waiting_for_password");
				return;
			}
			if (text.reason === "no_text") {
				// A scanned attachment beside the statement (台新 sends a payment
				// slip with every statement): it can never be read, so set it aside
				// and read the email's other PDFs. Retrying would hold the backfill's
				// month for hours.
				skipped.push(`${pdf.filename}: ${text.message}`);
				t.count("statement_pdf_no_text");
				continue;
			}
			return failed(t, row, `${pdf.filename}: ${text.message}`);
		}
		if (!opened) {
			opened = true;
			await pdfOpened(t, row, async () => accounts);
		}
		if (!text.encrypted && !upload && !t.banks().sendsUnlockedPdfs(institution)) {
			// A bank sends its statement locked with the owner's password. An
			// unlocked "statement" is someone else's document: never read it —
			// unless the owner's bank list says this bank sends them unlocked
			// ("pdf_password": false; the mail is still Gmail-vouched as that bank's).
			skipped.push(`${pdf.filename}: an unlocked statement PDF was refused (a real bank statement is password-protected)`);
			t.count("statement_unencrypted_refused");
			continue;
		}
		if (!counted && (t.pot === "catchup" || t.pot === "daily" || (t.pot === "main" && t.phase() === "daily")) && (await t.canPay()) <= 0) {
			// Opened (so a wrong password or an unreadable file is still told
			// at once), but nothing is left to pay its reading with: wait. The
			// catching up (uploads, bills read again) tells the owner why on his page.
			if (t.pot === "catchup") t.raiseCatchupCap();
			return waitForModel(t, row, "statement");
		}
		if (!counted && !t.subscription) {
			// (Subscription mode: asking is a database write, never cut off part-way,
			// and the unit comes back here until the reader answers — so nothing is
			// counted: its failures count as any unit's do.)
			// A statement reading is long. Count the attempt BEFORE paying for it:
			// a tick stopped mid-call (Cloudflare's time limit) then cannot
			// retry it for ever — the fifth time it goes to the owner instead.
			if (row.attempts + 1 >= MAX_ATTEMPTS) return failed(t, row, "the statement's reading never finished (the run was stopped part-way each time)");
			await setWork(t, row.gmail_id, { kind: "statement", attempts: row.attempts + 1, not_before: new Date(t.now().getTime() + RETRY_BASE_MS * 2 ** (row.attempts + 1)).toISOString() }).run();
			counted = true;
		}
		let tier: Tier = row.source === "backfill" && !reread ? "senior" : "daily";
		let note = "";
		for (;;) {
			const ask = [oneBillNote(accounts, institution), note].filter(Boolean).join("\n\n");
			const r = await readWith(t, tier, "statement", statementPrompt(m, pdf.filename, text.pages, ask, upload ? UPLOAD_ORIGIN[upload.via] : undefined), StatementSchema, 32000);
			if (!r.ok && r.why === "blocked" && r.pending) {
				// Subscription mode: this PDF waits for the reader; the email's other
				// PDFs are still handed over now, so they are read in the same round.
				waiting = true;
				break;
			}
			if (!r.ok && r.why === "blocked") return waitForModel(t, row, "statement");
			if (!r.ok) {
				if (tier === "daily") {
					tier = "senior";
					continue;
				}
				return failed(t, row, `${pdf.filename}: ${r.message}`);
			}
			let s: ReturnType<typeof statementsFromAnswer>;
			try {
				s = statementsFromAnswer(r.data, accounts, m.id, pdf.filename, senderAccount, upload ? null : t.banks().authenticated(from, m.auth ?? []));
			} catch {
				// Unfit figures: the senior reader once, then final.
				if (tier === "daily") {
					tier = "senior";
					continue;
				}
				return failed(t, row, UNFIT_FIGURES, true);
			}
			if ((!s.adds_up || r.data.confidence === "unsure") && tier === "daily") {
				tier = "senior";
				note = "A first reading of this statement did not add up (opening balance ± the lines ≠ closing balance). Read it again carefully: every line, every section.";
				continue;
			}
			// Still not adding up after the senior reading: imported anyway — the
			// month's reconciliation then escalates it to the owner with the detail.
			read.push(...s.read);
			unknown.push(...s.unknown);
			t.count(s.adds_up ? "statement_adds_up" : "statement_does_not_add_up");
			break;
		}
	}
	if (waiting) return waitForModel(t, row, "statement");
	// Not one PDF could be read: final at once (none of these reasons changes on a retry).
	if (skipped.length && !read.length && !unknown.length) return failed(t, row, skipped.join("; "), true);
	if (upload && !read.length && unknown.length) {
		// The owner's upload, a card the ledger does not know: he picks it in 待確認
		// (the file waits for him, at most 14 days; then it is deleted).
		const created = (await t.db.prepare("SELECT created_at FROM uploads WHERE id = ?").bind(row.gmail_id).first<{ created_at: string }>())?.created_at ?? t.iso();
		await t.db.batch([
			messageRow(t, m, "statement"),
			// Woken only when its 14 days are up (then deleted, never read again) — at least an hour from now.
			setWork(t, row.gmail_id, { kind: "statement", stage: "waiting", error: WAIT_PICK_ACCOUNT, not_before: new Date(Math.max(new Date(created).getTime() + UPLOAD_KEEP_MS, t.now().getTime() + 3_600_000)).toISOString() }),
			t.db.prepare("UPDATE uploads SET result_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify({ unknown: [...new Set(unknown)] }), t.iso(), row.gmail_id),
		]);
		t.count("upload_card_unknown");
		return;
	}
	const firstMonth = read.length ? read.map((r) => r.st.period_start.slice(0, 7)).sort()[0]! : null;
	// A reading again is never parked; today's statement only while the backfill
	// has not yet read its months' alerts (it is then released with them).
	const parked = !reread && (row.source === "backfill" || (row.source === "daily" && firstMonth !== null && !backfillPassed(t, firstMonth)));
	const park = parked ? firstMonth : null;
	const payload: Payload = { statements: read, next: 0, ...(reread ? { reread: true } : {}) };
	const engine = engineFor(t, head, "rules");
	await t.db.batch([
		messageRow(t, m, "statement"),
		setWork(t, row.gmail_id, { kind: "statement", stage: parked ? "parked" : "ingest", park_until_month: park, payload_json: JSON.stringify(payload), error: null }),
		...(unknown.length ? [escalateStmt(engine, "unknown_format", m.id, `A statement names card or account ending ${unknown.join(", ")}, which matches no account in the ledger.`)] : []),
		// Read and its figures saved: the uploaded file is deleted in the same breath.
		...(upload ? [forgetUpload(t.db, row.gmail_id)] : []),
	]);
	t.count("statements_read", read.length);
	if (!parked) return ingestUnit(t, { ...row, kind: "statement", stage: "ingest", payload_json: JSON.stringify(payload) });
}

/// Has the running backfill read every alert of `month` (and the months after)?
/// True when no backfill runs. A statement of today's mail imported before
/// then would meet its period with alerts still unread.
export function backfillPassed(t: Tick, month: string | null): boolean {
	if (t.phase() !== "backfill") return true;
	const b = t.get<BackfillState>("backfill");
	if (!b || b.done) return true;
	return month !== null && b.i > 0 && month >= b.months[b.i - 1]!;
}

/// Import a read statement, chunk by chunk ("stop" = the budget ran short).
async function ingestUnit(t: Tick, row: WorkRow): Promise<"stop" | void> {
	const payload = JSON.parse(row.payload_json ?? "{}") as Payload;
	const list = payload.statements ?? [];
	let next = payload.next ?? 0;
	const engine = engineFor(t, await t.head(), "rules");
	if (payload.reread && !payload.prepared) {
		const printed = list.reduce((n, r) => n + r.lines.length, 0);
		if (!t.room(Math.min(40 + 2 * printed, 300))) return "stop";
		const r = await prepareReread(engine, list);
		t.count("reread_lines_moved", r.moved);
		payload.statements = r.pieces;
		payload.prepared = true;
		await setWork(t, row.gmail_id, { payload_json: JSON.stringify(payload) }).run();
		return ingestUnit(t, { ...row, payload_json: JSON.stringify(payload) });
	}
	const results = payload.results ?? [];
	while (next < list.length) {
		if (!t.room(STATEMENT_COST.finish + STATEMENT_COST.line)) return "stop";
		const { st, lines } = list[next]!;
		const r = await ingestStatement(engine, st, lines, { budget: t.db });
		if (r.status === "partial") return "stop";
		t.count(`statement_${r.status}`);
		results.push({ account_id: st.account_id, period_end: st.period_end, status: r.status });
		next++;
		const done = next >= list.length;
		const saved = JSON.stringify({ ...payload, next, results });
		await t.db.batch([
			setWork(t, row.gmail_id, done ? { stage: "done", payload_json: saved, error: null } : { payload_json: saved }),
			...(done && isUploadId(row.gmail_id) ? [t.db.prepare("UPDATE uploads SET result_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(results), t.iso(), row.gmail_id)] : []),
		]);
	}
	if (!list.length) await setWork(t, row.gmail_id, { stage: "done" }).run();
	t.count("done_statement");
}

/// An uploaded statement: no Gmail at all — the file is in D1 (uploads.ts).
async function uploadUnit(t: Tick, row: WorkRow): Promise<"stop" | void> {
	const up = await loadUpload(t.db, row.gmail_id);
	const gone = !up || !up.bytes || t.now().getTime() - new Date(up.created_at).getTime() >= UPLOAD_KEEP_MS;
	if (gone) {
		await t.db.batch([setWork(t, row.gmail_id, { stage: "failed", error: UPLOAD_EXPIRED }), forgetUpload(t.db, row.gmail_id)]);
		t.count("upload_expired");
		return;
	}
	const m: Mail = {
		id: row.gmail_id,
		thread_id: null,
		from: `owner-upload-${up.via}`,
		subject: up.filename,
		headers: {},
		auth: [],
		received_at: up.created_at,
		text: "",
		pdfs: [{ filename: up.filename, attachment_id: "upload", size: up.bytes!.length }],
	};
	return statementUnit(t, row, m, false, { bytes: up.bytes!, account_id: up.account_id, via: up.via });
}

/// "mail": today's mail lane — a statement is only sorted here, and read by the work queue.
export type Lane = "mail" | "all";

async function unit(t: Tick, row: WorkRow, lane: Lane): Promise<"stop" | "skip" | void> {
	if (row.stage === "ingest") return ingestUnit(t, row);
	// Subscription mode: while a reading for this row is still with the reader,
	// nothing is fetched or opened again (the answer wakes the row at once).
	if (t.subscription && (await readerHolds(t, row.gmail_id))) return waitForModel(t, row, row.kind);
	if (isUploadId(row.gmail_id)) return uploadUnit(t, row);
	const gmail = t.svc.gmail;
	if (!gmail || t.gmailStopped) return "skip";
	const payload = JSON.parse(row.payload_json ?? "{}") as Payload;
	let m: Mail;
	try {
		m = await gmail.message(row.gmail_id);
		t.gmailSucceeded();
	} catch (e) {
		if (e instanceof GmailError && e.kind === "refused") return failed(t, row, e.message);
		t.gmailFailure(e);
		return "skip";
	}
	if (isOwnSummary({ from: m.from, subject: m.subject, headers: m.headers, body: m.text }, emailAddress(t.env.LEDGER_MAIL_FROM || DEFAULT_FROM))) return finish(t, m, "own_summary");
	if (payload.evidence) {
		// Read and paid for already; only the ingest was cut off.
		return ingestRead(t, row, m, payload.evidence.type === "receipt" ? "receipt" : "alert", payload.evidence, "rules");
	}
	const book = (await t.head())?.body ?? null;
	const kind = classify(m, book, t.banks(), ignoreSubjects(t.env.LEDGER_IGNORE_SUBJECTS));
	noteBankCheck(t, m, book, kind);
	if (kind === "ignored") {
		const noise = noiseReason(m, t.banks());
		if (noise) t.count(`ignored_${noise}`);
		return finish(t, m, "ignored");
	}
	if (kind === "alert") return alertUnit(t, row, m);
	if (kind === "receipt") return receiptUnit(t, row, m);
	if (lane === "mail") {
		await setWork(t, row.gmail_id, { kind: "statement" }).run();
		t.count("statement_left_for_queue");
		return;
	}
	return statementUnit(t, row, m, payload.reread === true);
}

/// A bank's own mail that fails Gmail's check is read only as a receipt. If
/// that is a REAL bank's mail (its sender check set up differently), the owner must
/// hear of it rather than lose its alerts or statements quietly — so it raises
/// an alarm, cleared when that bank's mail next passes.
export function noteBankCheck(t: Tick, m: Mail, book: Playbook | null, kind: string): void {
	const banks = t.banks();
	const unverified = unverifiedBank(m, book, banks);
	if (unverified) {
		const name = banks.label(unverified);
		t.count("bank_mail_unverified");
		t.raise(
			`bank_unverified:${unverified.toUpperCase()}`,
			`An email that says it is from ${name} did not pass Gmail's check that it really came from the bank, so the ledger read it only as an ordinary receipt (it cannot add or change anything). If ${name} really emails you this way, tell your developer; otherwise it was probably a fake and you can ignore it.`,
		);
	} else if (kind === "receipt") {
		const unknown = unknownBankSender(m, book, banks);
		if (unknown) {
			const name = banks.label(unknown.bank);
			t.count("bank_sender_unknown");
			t.raise(
				`bank_sender_unknown:${unknown.bank.toUpperCase()}`,
				`An email calling itself a ${name} transaction alert came from ${unknown.address}, which is not one of ${name}'s domains on your bank list, so the ledger read it only as an ordinary receipt (it cannot add anything). If that is really ${name}'s address, add its domain to ${name}'s "domains" in seed/accounts.json and load your accounts again (docs/adding-a-bank.md); otherwise it was probably a fake and you can ignore it.`,
			);
		}
	} else if (kind === "alert" || kind === "statement") {
		const bank = banks.authenticated(emailAddress(m.from), m.auth ?? []);
		if (bank) t.clear(`bank_unverified:${bank.toUpperCase()}`);
		// A real alert of that bank read again: its alerts are reaching the ledger.
		if (bank && kind === "alert") t.clear(`bank_sender_unknown:${bank.toUpperCase()}`);
	}
}

/// Whose money a row's reading is. A statement the owner uploaded, or one the look
/// back reads again, is catching up (its own approval, never the daily cap); a
/// row of the older months' reading (extend.ts) is paid from that approval;
/// everything else from the daily allowance (or the backfill's approval).
export function potOf(t: Tick, row: WorkRow): Pot {
	if (row.source === "owner_upload" || isUploadId(row.gmail_id)) return "catchup";
	if ((JSON.parse(row.payload_json ?? "{}") as Payload).reread) return "catchup";
	// Today's mail: the daily allowance, even while the backfill runs.
	if (row.source !== "backfill") return "daily";
	if (!row.month) return "main";
	const x = t.get<{ months?: string[]; done?: boolean }>("backfill_extra");
	if (!x || x.done || !x.months?.includes(row.month)) return "main";
	return "extra";
}

/// Due work: today's unsorted mail and bank alerts first, then any other
/// unsorted mail or alert (a backfill's), then receipts, then statements.

async function due(t: Tick, skip: readonly string[]): Promise<WorkRow[]> {
	return (
		await t.db
			.prepare(
				"SELECT gmail_id, source, month, kind, stage, attempts, not_before, park_until_month, payload_json FROM work " +
					"WHERE stage IN ('new', 'ingest', 'waiting') AND (not_before IS NULL OR not_before <= ?) AND gmail_id NOT IN (SELECT value FROM json_each(?)) " +
					"ORDER BY CASE WHEN stage = 'ingest' OR kind = 'statement' THEN 3 WHEN kind = 'receipt' THEN 2 WHEN source = 'daily' THEN 0 ELSE 1 END, created_at, gmail_id LIMIT 20",
			)
			.bind(t.iso(), JSON.stringify(skip))
			.all<WorkRow>()
	).results;
}

/// One row, charged to its pot. A failure is the row's, never the queue's.
async function runRow(t: Tick, row: WorkRow, lane: Lane): Promise<"stop" | "skip" | void> {
	try {
		t.readingFor = row.gmail_id;
		return await t.withPot(potOf(t, row), () => unit(t, row, lane));
	} catch (e) {
		if (!(e instanceof Error) || e instanceof BudgetExhausted) throw e;
		// A figure that will not convert never converts on a retry, and
		// its message quotes the email: final, in plain words.
		if (e instanceof RangeError) await failed(t, row, UNFIT_FIGURES, true);
		else await failed(t, row, e.message);
	} finally {
		t.readingFor = null;
	}
}

export const NO_BANKS_MESSAGE =
	'Your ledger has no banks on its list, so no email can be read as a bank\'s alert or statement (only receipts and Apple Pay taps are recorded). Add each bank and the mail domains it sends from under "banks" in seed/accounts.json, then load your accounts again (docs/accounts.md).';

export const workQueue: Step = {
	name: "work",
	async run(t) {
		// The net under the PDF-password warnings: anything else that moved a
		// locked bill (an upload skipped or expired, a tick cut short) is caught
		// within a few hours — and a warning written before 14 Oct
		// change is rewritten to name its bills at once.
		if (pdfLocksDue(t) && t.room(UNIT_COST)) await refreshLocks(t, await loadAccounts(t.db));
		// No bank on the owner's list: no mail can ever be read as a bank's. Say so.
		if (t.banks().isEmpty) t.raise("no_banks", NO_BANKS_MESSAGE);
		else t.clear("no_banks");
		const seen: string[] = [];
		for (let round = 0; round < 50 && t.room(UNIT_COST); round++) {
			const rows = await due(t, seen);
			if (!rows.length) return;
			for (const row of rows) {
				if (!t.room(row.stage === "ingest" ? STATEMENT_COST.finish + STATEMENT_COST.line : UNIT_COST)) return;
				seen.push(row.gmail_id);
				if ((await runRow(t, row, "all")) === "stop") return;
			}
		}
	},
};

// ------------------------------------------------------------ today's mail

/// Today's new mail, not yet sorted, and today's bank alerts — nothing else.
async function dueToday(t: Tick, skip: readonly string[]): Promise<WorkRow[]> {
	return (
		await t.db
			.prepare(
				"SELECT gmail_id, source, month, kind, stage, attempts, not_before, park_until_month, payload_json FROM work " +
					"WHERE source = 'daily' AND stage = 'new' AND (kind IS NULL OR kind = 'alert') AND (not_before IS NULL OR not_before <= ?) " +
					"AND gmail_id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at, gmail_id LIMIT 20",
			)
			.bind(t.iso(), JSON.stringify(skip))
			.all<WorkRow>()
	).results;
}

/// The first work of every tick, before the exchange-rate history, the
/// backfills, statements, uploads and the look back: the mail the mail check
/// just queued is sorted and every bank alert in it read. An alert a playbook
/// pattern fits needs no model and waits on no cap; one with no pattern may
/// use the whole daily allowance, mail reserve included. A receipt is only
/// marked (it is read later, behind the bank's mail), a statement only sorted.
export const todaysMail: Step = {
	name: "todays_mail",
	async run(t) {
		// Without Gmail nothing here can be read (an upload is not today's mail).
		if (!mailFlows(t)) return;
		const seen: string[] = [];
		for (let round = 0; round < 10 && t.room(UNIT_COST); round++) {
			const rows = await dueToday(t, seen);
			if (!rows.length) return;
			for (const row of rows) {
				if (!t.room(UNIT_COST)) return;
				seen.push(row.gmail_id);
				if ((await runRow(t, row, "mail")) === "stop") return;
			}
		}
	},
};

/// Bank mail (today's alerts, or mail not yet sorted) older than this is stuck.
export const STUCK_AFTER_MS = 2 * 3_600_000;
/// The watch looks at most this often.
export const WATCH_EVERY_MS = 15 * 60_000;

/// Why bank mail waits, in the owner's words, as far as the tick can tell.
async function stuckReason(t: Tick): Promise<string> {
	if (t.isOpen("credit_exhausted") || t.isOpen("key_rejected")) return "the AI reader is stopped — see the alarm about your Anthropic API.";
	const paused = t.get<string>("model_paused_until");
	if (paused && paused > t.iso()) return "the AI reader is paused for a while (Claude was not answering); it tries again by itself.";
	if (t.isOpen("google_signin") || !t.svc.gmail || t.gmailStopped) return "Gmail is not answering right now; the ledger tries again by itself.";
	if (t.subscription) return readerStuckReason(t);
	const left = await t.withPot("daily", () => t.withLane("mail", () => t.canPay()));
	if (left < 0.1) {
		const capUsd = Number(t.env.LEDGER_DAILY_SPEND_CAP_USD) || 3;
		return `today's US$${capUsd.toFixed(2)} allowance for the AI reader is used up, so emails no pattern can read wait for midnight (${home().timeZone} time). To read them sooner, raise LEDGER_DAILY_SPEND_CAP_USD.`;
	}
	return "the ledger keeps trying them. If this alarm stays, tell your developer: a bank may have changed how its emails look.";
}

/// Never wait quietly: every 15 minutes, look whether Gmail was checked
/// lately and whether any bank mail has waited more than two hours — and say
/// so on the owner's page (alarms mail_check_late, mail_stuck), with the reason.
export const mailWatch: Step = {
	name: "mail_watch",
	async run(t) {
		if (!todaysMailPhase(t) || !t.room(4)) return;
		const last = t.get<string>("mail_watch_at");
		if (last && t.now().getTime() - new Date(last).getTime() < WATCH_EVERY_MS) return;
		t.putLater("mail_watch_at", t.iso());
		const now = t.now().getTime();
		// The mail check itself.
		const check = t.get<MailCheck>("mail_check");
		const since = check?.ok_at ?? check?.started_at ?? null;
		if (since && now - new Date(since).getTime() > STUCK_AFTER_MS && !t.isOpen("google_signin")) {
			t.raise("mail_check_late", `The ledger has not managed to check your Gmail for new mail since ${localClockText(since)}, so recent spending may be missing. Nothing is lost: it catches up by itself once Gmail answers. If this stays for a day, tell your developer.`);
		} else t.clear("mail_check_late");
		// Bank mail waiting.
		const cutoff = new Date(now - STUCK_AFTER_MS).toISOString();
		const row = await t.db
			.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM work WHERE source = 'daily' AND stage IN ('new', 'waiting') AND (kind IS NULL OR kind = 'alert') AND created_at <= ?")
			.bind(cutoff)
			.first<{ n: number; oldest: string | null }>();
		const n = row?.n ?? 0;
		if (n > 0 && row?.oldest) {
			const reason = await stuckReason(t);
			t.raise("mail_stuck", `${n} bank email${n === 1 ? " has" : "s have"} waited more than 2 hours to be read (the oldest was found at ${localClockText(row.oldest)}), so recent card charges or transfers may be missing from your ledger. Why: ${reason}`);
			t.count("mail_stuck", n);
		} else t.clear("mail_stuck");
		// The catching up's alarm goes once nothing of it waits (an upload deleted unread, say).
		if (t.isOpen("catchup_cap")) {
			const waiting = await t.db
				.prepare("SELECT 1 AS x FROM work WHERE stage IN ('new', 'waiting') AND (source = 'owner_upload' OR payload_json LIKE '%\"reread\":true%') LIMIT 1")
				.bind()
				.first();
			if (!waiting) t.clear("catchup_cap");
		}
	},
};
