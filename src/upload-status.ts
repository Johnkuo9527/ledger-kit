/// Statement PDFs the owner uploads himself (Citi emails no statement, so
/// he downloads them from the Citi app or web banking). The worker stores and
/// reads them (worker/src/uploads.ts, worker/src/pipeline.ts); this file says
/// where each one stands, in plain words, for the page's progress list on 繳款
/// and for 待確認 (needsOk → `uploads`).
///
///   queued          stored, waiting for the next run (every minute)
///   read            the reading is done; the import is under way
///   imported        on the ledger (or already was: `duplicate`)
///   duplicate       every statement in it was already on the ledger
///   needs_account   the card on it matches no account — the owner picks it (待確認)
///   needs_password  locked, and no password the ledger has opens it
///   failed          could not be read, with the plain reason

import type { Db } from "./db";
import { say, sayList } from "./words";

export const UPLOAD_PREFIX = "upload:";
export const isUploadId = (id: string | null | undefined): boolean => !!id && id.startsWith(UPLOAD_PREFIX);
/// The id in an address: the hex after the prefix (no ':' to encode).
export const uploadKey = (id: string): string => id.slice(UPLOAD_PREFIX.length);
/// A file waits at most this long to be read; then it is deleted.
export const UPLOAD_KEEP_MS = 14 * 24 * 3_600_000;

/// Work-row errors the pipeline writes for an upload that waits on the owner.
export const WAIT_PICK_ACCOUNT = "pick account";
export const WAIT_PDF_PASSWORD = "pdf password";
/// The work-row error of an upload whose file was deleted before it was read.
export const UPLOAD_EXPIRED = "upload expired: the file waited 14 days and was deleted";

export type UploadState = "queued" | "read" | "imported" | "duplicate" | "needs_account" | "needs_password" | "failed";

export interface UploadResult {
	account_id: string;
	period_end: string;
	status: "imported" | "duplicate";
}

export interface UploadRow {
	id: string;
	filename: string;
	size: number;
	via: "page" | "share";
	account_id: string | null;
	result_json: string | null;
	dismissed_at: string | null;
	created_at: string;
	stage: string | null;
	error: string | null;
	attempts: number | null;
}

export interface UploadView {
	id: string; // the key used in addresses (no "upload:" prefix)
	filename: string;
	size: number;
	via: "page" | "share";
	created_at: string;
	state: UploadState;
	message: string;
	statements: { account_id: string; account: string; period_end: string; status: "imported" | "duplicate" }[];
	unknown_last4: string[];
}

const UPLOAD_SELECT =
	"SELECT u.id, u.filename, u.size, u.via, u.account_id, u.result_json, u.dismissed_at, u.created_at, w.stage, w.error, w.attempts FROM uploads u LEFT JOIN work w ON w.gmail_id = u.id";

/// A work row's error, said plainly for the owner (it was written for a developer).
export function uploadReason(error: string | null): string {
	const e = (error ?? "").toLowerCase();
	if (e.includes("dismissed by owner")) return say("upload.why_dismissed");
	if (e.includes("upload expired")) return say("upload.why_expired");
	if (e.includes("holds no text") || e.includes("no text")) return say("upload.why_no_text");
	if (e.includes("unfit")) return say("upload.why_unfit");
	if (e.includes("could not be read") || e.includes("invalid pdf") || e.includes("unreadable")) return say("upload.why_unreadable");
	if (e.includes("never finished")) return say("upload.why_never_finished");
	if (e.includes("no statement")) return say("upload.why_no_statement");
	return say("upload.why_other", { error: (error ?? say("upload.why_unknown")).slice(0, 160) });
}

function results(row: UploadRow): { list: UploadResult[]; unknown: string[] } {
	try {
		const v = JSON.parse(row.result_json ?? "null") as UploadResult[] | { unknown?: string[] } | null;
		if (Array.isArray(v)) return { list: v, unknown: [] };
		return { list: [], unknown: v?.unknown ?? [] };
	} catch {
		return { list: [], unknown: [] };
	}
}

export function uploadView(row: UploadRow, names: ReadonlyMap<string, string>): UploadView {
	const { list, unknown } = results(row);
	const statements = list.map((r) => ({ ...r, account: names.get(r.account_id) ?? r.account_id }));
	const base = { id: uploadKey(row.id), filename: row.filename, size: row.size, via: row.via, created_at: row.created_at, statements, unknown_last4: unknown };
	const view = (state: UploadState, message: string): UploadView => ({ ...base, state, message });
	switch (row.stage) {
		case "new":
			return view("queued", say(row.attempts ? "upload.again" : "upload.queued"));
		case "waiting":
			if (row.error === WAIT_PICK_ACCOUNT) return view("needs_account", unknown.length ? say("upload.no_card_digits", { digits: sayList(unknown) }) : say("upload.no_card"));
			if (row.error === WAIT_PDF_PASSWORD) return view("needs_password", say("upload.locked"));
			return view("queued", say("upload.waiting_budget"));
		case "ingest":
		case "parked":
			return view("read", say("upload.importing"));
		case "done": {
			const imported = statements.filter((s) => s.status === "imported");
			if (!statements.length) return view("failed", uploadReason("no statement"));
			const what = (xs: typeof statements) => sayList(xs.map((s) => say("upload.period", { account: s.account, end: s.period_end })));
			if (!imported.length) return view("duplicate", say("upload.duplicate", { what: what(statements) }));
			return view("imported", say("upload.imported", { what: what(imported) }));
		}
		case "failed":
			return view("failed", uploadReason(row.error));
		default:
			return view("failed", say("upload.lost"));
	}
}

async function accountNames(db: Db): Promise<Map<string, string>> {
	return new Map((await db.prepare("SELECT id, name FROM accounts").bind().all<{ id: string; name: string }>()).results.map((a) => [a.id, a.name]));
}

/// The progress list: uploads of the last `days` days, newest first.
export async function uploadsView(db: Db, nowIso: string, days = 60, limit = 100): Promise<UploadView[]> {
	const since = new Date(new Date(nowIso).getTime() - days * 86_400_000).toISOString();
	const rows = (await db.prepare(`${UPLOAD_SELECT} WHERE u.created_at >= ? ORDER BY u.created_at DESC, u.id LIMIT ?`).bind(since, limit).all<UploadRow>()).results;
	if (!rows.length) return [];
	const names = await accountNames(db);
	return rows.map((r) => uploadView(r, names));
}

/// The uploads waiting on the owner, for 待確認 (oldest first): a card to pick, a
/// lock no password opens, or a file that could not be read.
export async function uploadsNeedingOwner(db: Db, limit = 20): Promise<{ row: UploadRow; view: UploadView }[]> {
	const rows = (
		await db
			.prepare(`${UPLOAD_SELECT} WHERE u.dismissed_at IS NULL AND (w.stage = 'failed' OR (w.stage = 'waiting' AND w.error IN (?, ?))) ORDER BY u.created_at, u.id LIMIT ?`)
			.bind(WAIT_PICK_ACCOUNT, WAIT_PDF_PASSWORD, limit)
			.all<UploadRow>()
	).results;
	if (!rows.length) return [];
	const names = await accountNames(db);
	return rows.map((row) => ({ row, view: uploadView(row, names) }));
}
