/// Statement PDFs the owner hands the ledger himself . Citi emails no
/// statement: he downloads them from the Citi app or web banking and sends
/// them here — from the page (「上傳帳單」 on 繳款) or from the iPhone Share
/// Sheet (a Shortcut, 「送到帳本」).
///
///   POST /api/statements/upload   the page's session; multipart, 1–30 PDFs
///                                 (`files`), optional `account_id`
///   POST /api/statements/share    LEDGER_SHORTCUT_KEY (Bearer, constant time);
///                                 the raw PDF (application/pdf) or multipart;
///                                 answers ONE plain sentence for a notification
///   GET  /api/statements/uploads  the progress list (src/upload-status.ts)
///   POST /api/statements/uploads/:id/account {account_id}  the owner says which card
///   POST /api/statements/uploads/:id/dismiss               略過 / 知道了
///
/// Where the file waits: in D1 (`upload_chunks`, base64 pieces), ONLY until it
/// is read — the batch that saves the reading's figures deletes it, a failure
/// deletes it, and nothing waits longer than 14 days. D1, not KV or R2: the
/// worker has no R2 bucket (one would be a new go-live step for the owner), and KV
/// is eventually consistent (the cron, elsewhere, might not see a file stored
/// a second ago); D1 is the queue's own database, so the file and its work
/// row are written in one transaction and the cron sees both at once.
///
/// Trust: the owner's session (or his Shortcut key) is the proof of who sent it, so
/// an upload skips the Gmail bank-sender check, and an UNLOCKED PDF is
/// accepted (Citi's downloads are not locked). Its TEXT stays untrusted
/// exactly like an email: it is fenced for the reader, and nothing in it can
/// change who the ledger trusts.
///
/// The same file twice is one upload (its id is its SHA-256). The same
/// statement in two different files (downloaded twice) is imported once: the
/// engine keeps one statement per card and closing date.

import { localDate, localTime } from "../../src/home";
import { say } from "../../src/words";
import type { Db } from "../../src/db";
import { Refused } from "../../src/refused";
import { shortcutAuthorised } from "../../src/shortcut";
import { isUploadId, UPLOAD_KEEP_MS, UPLOAD_PREFIX, uploadKey, uploadsView, WAIT_PDF_PASSWORD, WAIT_PICK_ACCOUNT } from "../../src/upload-status";
import type { Deps, LedgerEnv } from "./env";
import { BASE_HEADERS, HttpError, ok, readJsonObject } from "./http";
import { resolveAccount, type Op } from "./ops";

export const UPLOAD_MAX_FILES = 30;
export const UPLOAD_MAX_FILE_BYTES = 10 * 1024 * 1024;
/// One request's whole body. The worker holds a request in memory (128 MB in
/// all), so a big batch is refused and the page sends one file per request.
export const UPLOAD_MAX_REQUEST_BYTES = 40 * 1024 * 1024;
/// Raw bytes per stored piece: a multiple of 3 (so the base64 pieces join),
/// ~700 KB of text — far under D1's 2 MB row limit.
export const CHUNK_BYTES = 525_000;
const FILENAME_MAX = 120;

export type Via = "page" | "share";

export interface Incoming {
	filename: string;
	bytes: Uint8Array | null; // null = refused before it was read (too large)
	size: number;
}

export interface Taken {
	filename: string;
	status: "queued" | "duplicate" | "refused";
	id: string | null; // the upload's key (no prefix)
	message: string;
}

// ------------------------------------------------------------------ bytes

/// "%PDF-" in the first 1 KB (where every PDF reader looks for it).
export function looksLikePdf(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, 1024);
	for (let i = 0; i + 5 <= head.length; i++) {
		if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
	}
	return false;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
	const s = atob(text);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

/// A name to show, never a path or a control character.
export function cleanFilename(name: string | null | undefined, fallback: string): string {
	const base = (name ?? "").split(/[\\/]/).pop() ?? "";
	const clean = base.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "").trim();
	return (clean || fallback).slice(0, FILENAME_MAX);
}

// ------------------------------------------------------------------ storing

/// Store each acceptable file and queue it for the cron's reading. Never
/// throws for one bad file: each gets its own answer.
export async function takeUploads(db: Db, now: Date, files: readonly Incoming[], opts: { via: Via; account_id: string | null }): Promise<Taken[]> {
	const iso = now.toISOString();
	// Anything left behind (a file that waited 14 days for a card or a password) goes now.
	await db.prepare("DELETE FROM upload_chunks WHERE upload_id IN (SELECT id FROM uploads WHERE created_at < ?)").bind(new Date(now.getTime() - UPLOAD_KEEP_MS).toISOString()).run();
	const out: Taken[] = [];
	const good: { i: number; id: string; bytes: Uint8Array }[] = [];
	for (const [i, f] of files.entries()) {
		const refuse = (message: string) => (out[i] = { filename: f.filename, status: "refused", id: null, message });
		if (f.size > UPLOAD_MAX_FILE_BYTES || (f.bytes && f.bytes.byteLength > UPLOAD_MAX_FILE_BYTES)) refuse(say("upload.too_big_file"));
		else if (!f.bytes || f.bytes.byteLength === 0) refuse(say("upload.empty"));
		else if (!looksLikePdf(f.bytes)) refuse(say("upload.not_pdf"));
		else good.push({ i, id: UPLOAD_PREFIX + (await sha256Hex(f.bytes)), bytes: f.bytes });
	}
	const known = new Map(
		(
			await db
				.prepare("SELECT u.id, w.stage FROM uploads u LEFT JOIN work w ON w.gmail_id = u.id WHERE u.id IN (SELECT value FROM json_each(?))")
				.bind(JSON.stringify(good.map((x) => x.id)))
				.all<{ id: string; stage: string | null }>()
		).results.map((r) => [r.id, r.stage]),
	);
	const seen = new Set<string>();
	for (const { i, id, bytes } of good) {
		const f = files[i]!;
		const key = uploadKey(id);
		if (seen.has(id) || (known.has(id) && known.get(id) !== "failed" && known.get(id) !== null)) {
			out[i] = { filename: f.filename, status: "duplicate", id: key, message: say("upload.already") };
			continue;
		}
		seen.add(id);
		// 1. The upload's row (a failed one before is taken again: the reading may work now).
		await db.batch([
			db
				.prepare(
					"INSERT INTO uploads (id, filename, size, via, account_id, result_json, dismissed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?) " +
						"ON CONFLICT (id) DO UPDATE SET filename = excluded.filename, via = excluded.via, account_id = excluded.account_id, result_json = NULL, dismissed_at = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at",
				)
				.bind(id, f.filename, bytes.byteLength, opts.via, opts.account_id, iso, iso),
			db.prepare("DELETE FROM upload_chunks WHERE upload_id = ?").bind(id),
		]);
		// 2. The file, one piece per query (each well inside D1's limits; a 10 MB
		//    file is 20 of them). Cut off here, nothing is queued: the upload has
		//    no work row, so it may simply be sent again, and the pieces left
		//    behind go with the 14-day sweep above.
		for (let at = 0, seq = 0; at < bytes.length; at += CHUNK_BYTES, seq++) {
			await db.prepare("INSERT OR REPLACE INTO upload_chunks (upload_id, seq, data) VALUES (?, ?, ?)").bind(id, seq, toBase64(bytes.subarray(at, at + CHUNK_BYTES))).run();
		}
		// 3. Only now does the cron see it.
		await db
			.prepare(
				"INSERT INTO work (gmail_id, source, month, kind, stage, attempts, not_before, park_until_month, payload_json, error, created_at, updated_at) VALUES (?, 'owner_upload', NULL, 'statement', 'new', 0, NULL, NULL, NULL, NULL, ?, ?) " +
					"ON CONFLICT (gmail_id) DO UPDATE SET stage = 'new', kind = 'statement', attempts = 0, not_before = NULL, payload_json = NULL, error = NULL, updated_at = excluded.updated_at",
			)
			.bind(id, iso, iso)
			.run();
		out[i] = { filename: f.filename, status: "queued", id: key, message: say("upload.queued_full") };
	}
	return out;
}

/// The stored file (null once it is gone) and what the owner said about it.
export async function loadUpload(db: Db, id: string): Promise<{ filename: string; via: Via; account_id: string | null; created_at: string; bytes: Uint8Array | null } | null> {
	const meta = await db.prepare("SELECT filename, via, account_id, created_at FROM uploads WHERE id = ?").bind(id).first<{ filename: string; via: Via; account_id: string | null; created_at: string }>();
	if (!meta) return null;
	const pieces = (await db.prepare("SELECT data FROM upload_chunks WHERE upload_id = ? ORDER BY seq").bind(id).all<{ data: string }>()).results;
	if (!pieces.length) return { ...meta, bytes: null };
	const parts = pieces.map((p) => fromBase64(p.data));
	const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		bytes.set(p, at);
		at += p.length;
	}
	return { ...meta, bytes };
}

/// Deletes the stored file (joins the batch that ends its wait).
export function forgetUpload(db: Db, id: string) {
	return db.prepare("DELETE FROM upload_chunks WHERE upload_id = ?").bind(id);
}

// ------------------------------------------------------------------ reading a request

/// The files of a multipart body (`files`, or `file`), refused whole when it
/// is not one or is too big. A file over the limit is not read into memory.
async function multipartFiles(request: Request): Promise<{ files: Incoming[]; account: string | null }> {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		throw new HttpError(400, say("upload.no_form"));
	}
	const raw = [...form.getAll("files"), ...form.getAll("file")].filter((v): v is File => typeof v === "object" && v !== null && "arrayBuffer" in v);
	if (!raw.length) throw new HttpError(400, say("upload.no_files"));
	if (raw.length > UPLOAD_MAX_FILES) throw new HttpError(400, say("upload.too_many", { n: UPLOAD_MAX_FILES }));
	const files: Incoming[] = [];
	for (const f of raw) {
		const filename = cleanFilename(f.name, say("upload.default_name"));
		files.push({ filename, size: f.size, bytes: f.size > UPLOAD_MAX_FILE_BYTES ? null : new Uint8Array(await f.arrayBuffer()) });
	}
	const account = form.get("account_id");
	return { files, account: typeof account === "string" && account.trim() ? account.trim() : null };
}

function tooBig(request: Request, max: number): boolean {
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	return Number.isFinite(declared) && declared > max;
}

/// The account the owner named, if any: a card or a bank account, never guessed.
async function namedAccount(db: Db, value: string | null): Promise<string | null> {
	if (!value) return null;
	const a = await resolveAccount(db, value);
	if (a.kind !== "credit_card" && a.kind !== "bank") throw new Refused(`${a.name} has no statements; pick a card or a bank account`);
	return a.id;
}

function summary(taken: readonly Taken[]): string {
	const n = (s: Taken["status"]) => taken.filter((t) => t.status === s).length;
	const parts = [
		n("queued") ? say("upload.sum_queued", { n: n("queued") }) : "",
		n("duplicate") ? say("upload.sum_duplicate", { n: n("duplicate") }) : "",
		n("refused") ? say("upload.sum_refused", { n: n("refused"), why: taken.find((t) => t.status === "refused")!.message }) : "",
	];
	return parts.filter(Boolean).join(say("upload.sum_sep"));
}

// ------------------------------------------------------------------ the routes

/// POST /api/statements/upload (the page; app.ts checked the session).
export async function uploadFromPage(op: Op, request: Request, now: Date): Promise<Response> {
	if (tooBig(request, UPLOAD_MAX_REQUEST_BYTES)) throw new HttpError(413, say("upload.too_big_request"));
	if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("multipart/form-data")) throw new HttpError(400, say("upload.use_multipart"));
	const { files, account } = await multipartFiles(request);
	const account_id = await namedAccount(op.db, account);
	const taken = await takeUploads(op.db, now, files, { via: "page", account_id });
	return ok({ files: taken, queued: taken.filter((t) => t.status === "queued").length, message: summary(taken) });
}

function plain(status: number, message: string): Response {
	return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS } });
}

/// POST /api/statements/share — the iPhone Share Sheet. Its own key, checked
/// before anything is read; one plain sentence back for the notification.
export async function shareRoute(request: Request, env: LedgerEnv, deps: Deps): Promise<Response> {
	if (request.method !== "POST") return plain(405, say("upload.use_post"));
	if (!(await shortcutAuthorised(request.headers.get("Authorization"), env.LEDGER_SHORTCUT_KEY))) return plain(401, say("upload.bad_key"));
	try {
		const type = (request.headers.get("Content-Type") ?? "").toLowerCase();
		let files: Incoming[];
		let account: string | null = null;
		if (type.startsWith("multipart/form-data")) {
			if (tooBig(request, UPLOAD_MAX_REQUEST_BYTES)) return plain(413, say("upload.too_big_share"));
			({ files, account } = await multipartFiles(request));
		} else {
			if (tooBig(request, UPLOAD_MAX_FILE_BYTES)) return plain(413, say("upload.too_big_file_short"));
			const bytes = new Uint8Array(await request.arrayBuffer());
			const stamp = `${localDate(deps.now())} ${localTime(deps.now())}`;
			const given = request.headers.get("X-Filename") ?? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(request.headers.get("Content-Disposition") ?? "")?.[1] ?? null;
			let name: string | null = given;
			try {
				name = given ? decodeURIComponent(given) : null;
			} catch {
				/* keep it as sent */
			}
			files = [{ filename: cleanFilename(name, say("upload.share_name", { stamp })), size: bytes.byteLength, bytes }];
			account = new URL(request.url).searchParams.get("account");
		}
		const account_id = await namedAccount(env.LEDGER_DB, account);
		const taken = await takeUploads(env.LEDGER_DB, deps.now(), files, { via: "share", account_id });
		if (taken.every((t) => t.status === "refused")) return plain(400, taken.length === 1 ? say("upload.refused", { why: taken[0]!.message }) : summary(taken));
		if (taken.length === 1) return plain(200, say(taken[0]!.status === "queued" ? "upload.share_queued" : "upload.share_duplicate"));
		return plain(200, summary(taken));
	} catch (e) {
		if (e instanceof HttpError) return plain(e.status, e.message);
		if (e instanceof Refused) return plain(400, e.message);
		console.error("ledger share failed", e);
		return plain(500, say("upload.share_down"));
	}
}

/// GET /api/statements/uploads — the progress list on 繳款.
export async function uploadsList(op: Op, now: Date): Promise<Response> {
	return ok({ uploads: await uploadsView(op.db, now.toISOString()) });
}

async function uploadRow(db: Db, key: string): Promise<{ id: string; stage: string | null; error: string | null; has_file: number }> {
	const id = UPLOAD_PREFIX + key;
	if (!/^[0-9a-f]{64}$/.test(key)) throw new HttpError(404, "no such upload");
	const row = await db
		.prepare("SELECT u.id, w.stage, w.error, EXISTS (SELECT 1 FROM upload_chunks c WHERE c.upload_id = u.id) AS has_file FROM uploads u LEFT JOIN work w ON w.gmail_id = u.id WHERE u.id = ?")
		.bind(id)
		.first<{ id: string; stage: string | null; error: string | null; has_file: number }>();
	if (!row) throw new HttpError(404, "no such upload");
	return row;
}

/// POST /api/statements/uploads/:id/account {account_id} — the owner says which
/// card it is: read again for that card (the file is kept until then).
export async function uploadAccount(op: Op, request: Request, key: string, now: Date): Promise<Response> {
	const body = await readJsonObject(request);
	const row = await uploadRow(op.db, key);
	const account_id = await namedAccount(op.db, typeof body.account_id === "string" ? body.account_id : null);
	if (!account_id) throw new Refused("account_id is missing");
	if (row.stage !== "waiting" || (row.error !== WAIT_PICK_ACCOUNT && row.error !== WAIT_PDF_PASSWORD)) throw new Refused(say("upload.no_pick_needed"));
	if (!row.has_file) throw new Refused(say("upload.file_gone"));
	const iso = now.toISOString();
	await op.db.batch([
		op.db.prepare("UPDATE uploads SET account_id = ?, result_json = NULL, updated_at = ? WHERE id = ?").bind(account_id, iso, row.id),
		op.db.prepare("UPDATE work SET stage = 'new', attempts = 0, not_before = NULL, error = NULL, payload_json = NULL, updated_at = ? WHERE gmail_id = ?").bind(iso, row.id),
	]);
	return ok({ message: say("upload.read_again") });
}

/// POST /api/statements/uploads/:id/dismiss — off 待確認; a file still
/// waiting is deleted and the upload ends as failed.
export async function uploadDismiss(op: Op, key: string, now: Date): Promise<Response> {
	const row = await uploadRow(op.db, key);
	const iso = now.toISOString();
	const waiting = row.stage === "waiting";
	await op.db.batch([
		op.db.prepare("UPDATE uploads SET dismissed_at = ?, updated_at = ? WHERE id = ?").bind(iso, iso, row.id),
		...(waiting ? [op.db.prepare("UPDATE work SET stage = 'failed', error = 'dismissed by the owner', updated_at = ? WHERE gmail_id = ?").bind(iso, row.id), forgetUpload(op.db, row.id)] : []),
	]);
	return ok({ message: say("upload.dismissed") });
}

export { isUploadId };
