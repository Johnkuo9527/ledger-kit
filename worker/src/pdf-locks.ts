/// Statement PDFs that will not open (14 Oct 2026). The owner's ask: "have
/// the warning name the exact bill" — 「2024 年 9 月寄來的台新帳單打不開」.
///
/// Still ONE alarm per bank (`pdf_password:<BANK>`), but its message is rebuilt
/// from the bills STILL waiting on a password — work rows `stage = 'waiting'
/// AND error = WAIT_PDF_PASSWORD` — never from the last event. So a newer bill
/// that opens does not clear it (it used to, and an older locked bill raised it
/// again: the warning flapped), and it goes only when no bill of that bank is
/// still locked. Nothing new is stored: the bank, the month and the card come
/// from the email's own row (`messages`) and an upload's own row (`uploads`);
/// why it would not open (no password set, or none of them fitted) is noted in
/// the work row's payload when it was locked (`pdf_lock`, see `withLockNote`).
///
/// The month is the one the EMAIL ARRIVED in (帳單寄出月份): a PDF that will
/// not open has no statement period we could read, so the warning says
/// 「…寄來的」, which is true, rather than naming a period it cannot know.
///
/// When it is rebuilt: by the pipeline the moment a bill is locked, and when a
/// bill that was waiting opens (pipeline.ts); and, as a net under anything else
/// that moves a locked row (an upload the owner skips or that expires, a tick cut
/// short), at most every few hours while such an alarm is open (`pdfLocksNet`).

import type { BankList } from "./banks";
import { localDate } from "../../src/home";
import { emailAddress } from "../../src/dedup";
import { defaultPdfSecretName, type Playbook } from "../../src/playbook";
import { bankName, fixMark, waitMark } from "../../src/queries";
import { inline, say, sayList, sayMonth } from "../../src/words";
import type { Account } from "../../src/types";
import { isUploadId, WAIT_PDF_PASSWORD } from "../../src/upload-status";
import { institutionOf, senderMatches } from "./read";
import type { Tick } from "./tick";

export const PDF_ALARM_PREFIX = "pdf_password:";
/// The net looks again at most this often while a PDF alarm is open.
export const PDF_LOCKS_NET_MS = 6 * 3_600_000;
const NET_KEY = "pdf_locks_checked";
/// The warning lists at most this many bills; the rest are "還有 N 期".
export const PDF_LOCKS_LISTED = 5;
const FILE_CHARS = 60;

/// A locked bill as the database has it.
export interface LockedRow {
	gmail_id: string;
	kind: string | null;
	from_addr: string | null;
	/// When the email arrived (an upload: when the owner uploaded it).
	received_at: string;
	/// An upload: its file name and the card the owner said it is (null: not said).
	filename: string | null;
	upload_account: string | null;
	payload_json: string | null;
}

/// Why a bill would not open, as it was when the ledger last tried it.
export type LockReason = "wrong_password" | "no_password";

/// The work row's payload with why its PDF would not open noted in it (the
/// rest — a re-read's flag — is kept). Replaced by the reading once it opens.
export function withLockNote(payloadJson: string | null, reason: LockReason): string {
	let p: Record<string, unknown> = {};
	try {
		const x = JSON.parse(payloadJson ?? "{}") as unknown;
		if (x && typeof x === "object" && !Array.isArray(x)) p = x as Record<string, unknown>;
	} catch {
		// an unreadable payload: start afresh (a locked row has no reading to keep)
	}
	return JSON.stringify({ ...p, pdf_lock: reason });
}

function lockNote(payloadJson: string | null): LockReason | null {
	try {
		const r = (JSON.parse(payloadJson ?? "{}") as { pdf_lock?: unknown }).pdf_lock;
		return r === "wrong_password" || r === "no_password" ? r : null;
	} catch {
		return null;
	}
}

/// One locked bill, sorted to its bank.
export interface LockedBill {
	gmail_id: string;
	institution: string;
	/// The owner's date the email arrived (or the upload came in).
	arrived: string;
	/// An upload's file name; null for a bill that came by email.
	file: string | null;
	/// The card (or wallet) when it is known: the upload's card, the playbook's
	/// sender for that address, or the GrabPay wallet.
	account_id: string | null;
	/// Why it would not open when last tried; null = not noted (a bill locked
	/// before 14 Oct 2026): then whether any password is set now says.
	reason: LockReason | null;
}

export async function lockedRows(t: Tick): Promise<LockedRow[]> {
	return (
		await t.db
			.prepare(
				"SELECT w.gmail_id AS gmail_id, w.kind AS kind, m.from_addr AS from_addr, COALESCE(m.received_at, u.created_at, w.created_at) AS received_at, " +
					"u.filename AS filename, u.account_id AS upload_account, w.payload_json AS payload_json FROM work w LEFT JOIN messages m ON m.gmail_id = w.gmail_id LEFT JOIN uploads u ON u.id = w.gmail_id " +
					"WHERE w.stage = 'waiting' AND w.error = ? ORDER BY received_at DESC, w.gmail_id LIMIT 200",
			)
			.bind(WAIT_PDF_PASSWORD)
			.all<LockedRow>()
	).results;
}

const ownDay = (iso: string): string => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : localDate(d);
};

/// Each locked bill's bank, as the pipeline decided it when the PDF would not
/// open: an upload's card (an upload whose card the owner has not said raises no
/// bank's warning — 待確認 asks him which card it is); Grab's mail (the only
/// locked row that is a receipt) the GrabPay wallet; any other email the bank
/// of the address it came from. Newest first.
export function sortLocked(rows: readonly LockedRow[], accounts: readonly Account[], book: Playbook | null, banks: BankList): Map<string, LockedBill[]> {
	const out = new Map<string, LockedBill[]>();
	const wallet = accounts.find((a) => a.kind === "wallet" && a.institution === "grab" && a.active === 1) ?? null;
	for (const r of rows) {
		let institution: string | null;
		let account_id: string | null = null;
		if (isUploadId(r.gmail_id)) {
			const a = r.upload_account ? accounts.find((x) => x.id === r.upload_account) : undefined;
			institution = a?.institution ?? null;
			account_id = a?.id ?? null;
		} else if (r.kind === "receipt") {
			institution = wallet?.institution ?? "grab";
			account_id = wallet?.id ?? null;
		} else {
			const from = emailAddress(r.from_addr ?? "");
			institution = institutionOf(from, book, banks) ?? "other";
			account_id = book?.senders.statements.find((s) => senderMatches(s.from, from))?.account_id ?? null;
		}
		if (!institution) continue;
		const bill: LockedBill = { gmail_id: r.gmail_id, institution, arrived: ownDay(r.received_at), file: isUploadId(r.gmail_id) ? (r.filename ?? "") : null, account_id, reason: lockNote(r.payload_json) };
		const list = out.get(institution) ?? [];
		list.push(bill);
		out.set(institution, list);
	}
	for (const list of out.values()) list.sort((a, b) => b.arrived.localeCompare(a.arrived) || a.gmail_id.localeCompare(b.gmail_id));
	return out;
}

export interface LockFix {
	/// The bank's own secret: LEDGER_PDF_PW_<BANK>.
	secret: string;
	/// A card's older password (LEDGER_PDF_PW_<CARD>_2), for bills from before
	/// the bank changed it; null where it does not apply (no card, or a wallet).
	older_secret: string | null;
}

/// What the owner reads, in his language: which bills will not open, why, and the
/// one command that fixes it (the secret's NAME only, never a value). A bill
/// whose reason is not noted counts as a wrong password. A bill is named by the
/// month its email ARRIVED in.
export function lockedMessage(institution: string, bills: readonly LockedBill[], fix: LockFix, cardName: (id: string) => string | null): string {
	const bank = bankName(institution);
	const why = (b: LockedBill) => say(b.reason === "no_password" ? "pdf.why_unset" : "pdf.why_wrong");
	const one = new Set(bills.map(why)).size === 1 ? why(bills[0]!) : null; // the same reason for all: said once
	const ym = (day: string) => sayMonth(day.slice(0, 7));
	const file = (f: string) => (f.length > FILE_CHARS ? `${f.slice(0, FILE_CHARS - 1)}…` : f);
	const card = (b: LockedBill) => (b.account_id ? cardName(b.account_id) : null);
	let what: string;
	if (bills.length === 1) {
		const b = bills[0]!;
		const label = inline(card(b) ?? bank);
		what = b.file !== null ? say("pdf.one_uploaded", { label, file: file(b.file), why: why(b) }) : say("pdf.one_mailed", { month: ym(b.arrived), label, why: why(b) });
	} else {
		const item = (b: LockedBill) => {
			const c = card(b);
			const parts = [c, one ? null : why(b)].filter(Boolean).join(say("pdf.part_sep"));
			const head = b.file !== null ? say("pdf.item_uploaded", { file: file(b.file) }) : say("pdf.item_mailed", { month: ym(b.arrived) });
			return parts ? say("pdf.item_with", { item: head, parts }) : head;
		};
		const shown = sayList(bills.slice(0, PDF_LOCKS_LISTED).map(item));
		const more = bills.length > PDF_LOCKS_LISTED ? say("pdf.more", { n: bills.length - PDF_LOCKS_LISTED }) : "";
		what = say(one ? "pdf.many_one_reason" : "pdf.many", { n: bills.length, bank: inline(bank), why: one ?? "", shown, more });
	}
	const how = bills.every((b) => b.reason === "no_password")
		? say("pdf.how_set", { secret: fix.secret })
		: fix.older_secret
			? say("pdf.how_fix_older", { secret: fix.secret, older: fix.older_secret })
			: say("pdf.how_fix", { secret: fix.secret });
	// 待確認 splits the message at its fix and wait marks (src/queries.ts needsOk).
	return `${what}${fixMark()}${how}${waitMark()}${say("pdf.retry_daily")}`;
}

/// Rebuild every PDF-password alarm from the bills still locked: raised (or its
/// message refreshed) for each bank with one, cleared for each bank with none.
/// `passwordSet(institution, accountIds)`: is any secret set that the ledger
/// tries for that bank's PDFs (pipeline.ts pdfPasswords)? — asked only for a
/// bill whose reason was not noted when it was locked. Two queries.
export async function refreshPdfLocks(t: Tick, accounts: readonly Account[], passwordSet: (institution: string, accountIds: readonly string[]) => boolean): Promise<void> {
	const book = (await t.head())?.body ?? null;
	const byBank = sortLocked(await lockedRows(t), accounts, book, t.banks());
	const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? null;
	for (const key of [...t.alarms.keys()]) {
		if (key.startsWith(PDF_ALARM_PREFIX) && ![...byBank.keys()].some((i) => `${PDF_ALARM_PREFIX}${i.toUpperCase()}` === key)) t.clear(key as `pdf_password:${string}`);
	}
	for (const [institution, bills] of byBank) {
		const own = accounts.filter((a) => a.institution === institution && (a.kind === "credit_card" || a.kind === "bank") && a.has_statements === 1).map((a) => a.id);
		const picked = bills.map((b) => b.account_id).filter((id): id is string => !!id);
		const ids = [...new Set([...own, ...picked])];
		const isWallet = accounts.some((a) => a.institution === institution && a.kind === "wallet");
		// The older password goes on a card: the newest bill's own card if known, else the bank's first (every card's `_2` is tried for every bill of the bank).
		const olderCard = isWallet ? null : (bills.find((b) => b.account_id && own.includes(b.account_id))?.account_id ?? [...own].sort()[0] ?? null);
		const fix: LockFix = { secret: defaultPdfSecretName(institution), older_secret: olderCard ? `${defaultPdfSecretName(olderCard)}_2` : null };
		const fallback: LockReason | null = bills.some((b) => !b.reason) ? (passwordSet(institution, ids) ? "wrong_password" : "no_password") : null;
		const told = bills.map((b) => (b.reason ? b : { ...b, reason: fallback }));
		t.raise(`${PDF_ALARM_PREFIX}${institution.toUpperCase()}`, lockedMessage(institution, told, fix, name));
	}
	t.putLater(NET_KEY, t.iso());
}

/// The net: while a PDF alarm is open, look again every few hours (and at once
/// the first time, which also rewrites an alarm written before this change).
export function pdfLocksDue(t: Tick): boolean {
	if (![...t.alarms.keys()].some((k) => k.startsWith(PDF_ALARM_PREFIX))) return false;
	const last = t.get<string>(NET_KEY);
	return !last || t.now().getTime() - new Date(last).getTime() >= PDF_LOCKS_NET_MS;
}
