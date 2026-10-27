/// Opening a bank's password-protected statement PDF INSIDE the worker, and
/// reading its text out — the step Claude's API cannot do itself (it refuses
/// an encrypted PDF).
///
/// The library is Mozilla's PDF.js (the engine behind Firefox's PDF viewer),
/// in the serverless build that `unpdf` packages for edge runtimes like
/// Cloudflare Workers. PDF.js implements the PDF standard security handler in
/// pure JavaScript: 40- and 128-bit RC4 (revisions 2-3), AES-128 (revision 4)
/// and AES-256 (revisions 5-6, PDF 2.0). test/pdf.test.ts proves each one on
/// made-up statements; test/fixtures/make-pdfs.py makes them.
///
/// What leaves this file is TEXT, laid out line by line as on the page. The
/// PDF itself is never stored (CONTRACT.md §4.2: read and discarded), and the
/// password only ever comes from a worker secret (LEDGER_PDF_PW_<BANK>).

import { getDocumentProxy } from "unpdf";

export type PdfFailure = "needs_password" | "wrong_password" | "unreadable" | "no_text" | "too_large";

export type PdfText =
	| { ok: true; pages: string[]; page_count: number; chars: number; encrypted: boolean }
	| { ok: false; reason: PdfFailure; message: string };

/// Gmail allows 25 MB attachments; a monthly statement is well under 2 MB.
/// Anything bigger is not a statement, and would strain the worker's memory.
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
/// A statement is a few pages; this stops a 500-page brochure eating the run.
export const MAX_PAGES = 60;

interface TextItem {
	str: string;
	transform: number[];
	width: number;
}

/// One page's text items → lines, top to bottom, left to right. Items on the
/// same baseline (within 2 points) form a line; a wide gap between items is
/// kept as a wide gap so columns (date · description · amount) stay apart.
export function layoutLines(items: readonly TextItem[]): string[] {
	const rows: { y: number; items: TextItem[] }[] = [];
	for (const it of items) {
		if (!it.str) continue;
		const y = it.transform[5] ?? 0;
		const row = rows.find((r) => Math.abs(r.y - y) <= 2);
		if (row) row.items.push(it);
		else rows.push({ y, items: [it] });
	}
	rows.sort((a, b) => b.y - a.y);
	return rows
		.map((r) => {
			const sorted = r.items.sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
			let out = "";
			let end: number | null = null;
			for (const it of sorted) {
				const x = it.transform[4] ?? 0;
				if (end !== null) {
					const gap = x - end;
					out += gap > 12 ? "    " : gap > 1 ? " " : "";
				}
				out += it.str;
				end = x + (it.width || 0);
			}
			return out.replace(/\s+$/, "");
		})
		.filter((l) => l.trim().length > 0);
}

function failure(e: unknown): PdfText {
	const err = e as { name?: string; code?: number; message?: string };
	if (err?.name === "PasswordException") {
		// PDF.js: code 1 = a password is needed, 2 = the one given is wrong.
		return err.code === 2
			? { ok: false, reason: "wrong_password", message: "the statement's password was refused" }
			: { ok: false, reason: "needs_password", message: "the statement needs a password and none was set" };
	}
	return { ok: false, reason: "unreadable", message: `the PDF could not be read: ${String(err?.message ?? e).slice(0, 200)}` };
}

/// Unlock (when a password is given) and read a PDF. Never throws.
export async function readPdfText(bytes: Uint8Array, password: string | null): Promise<PdfText> {
	if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, reason: "too_large", message: `the PDF is ${bytes.byteLength} bytes; the limit is ${MAX_PDF_BYTES}` };
	let doc: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
	try {
		// PDF.js takes ownership of (and may detach) the buffer: hand it a copy.
		doc = await getDocumentProxy(new Uint8Array(bytes), {
			...(password !== null ? { password } : {}),
			useSystemFonts: false,
			disableFontFace: true,
			verbosity: 0,
		});
		const encrypted = await isEncrypted(doc);
		const count = Math.min(doc.numPages, MAX_PAGES);
		const pages: string[] = [];
		for (let i = 1; i <= count; i++) {
			const page = await doc.getPage(i);
			const content = await page.getTextContent();
			pages.push(layoutLines(content.items.filter((x): x is TextItem & typeof x => "str" in x) as TextItem[]).join("\n"));
			page.cleanup();
		}
		const chars = pages.reduce((n, p) => n + p.replace(/\s/g, "").length, 0);
		// A scanned statement has pictures of text, not text. Say so plainly
		// rather than hand the model empty pages and get an empty month back.
		if (chars === 0) return { ok: false, reason: "no_text", message: "the PDF opened but holds no text (a scanned image?)" };
		return { ok: true, pages, page_count: doc.numPages, chars, encrypted };
	} catch (e) {
		return failure(e);
	} finally {
		// Frees PDF.js's copy of the file and its parsed objects.
		await Promise.resolve(doc?.loadingTask?.destroy()).catch(() => {});
	}
}

async function isEncrypted(doc: { getMetadata(): Promise<{ info: unknown }> }): Promise<boolean> {
	try {
		const { info } = await doc.getMetadata();
		return Boolean((info as { EncryptFilterName?: unknown } | null)?.EncryptFilterName);
	} catch {
		return false;
	}
}

/// Try each candidate password in turn (the account's own secret first, then
/// the bank's). Only "wrong password" moves on to the next one.
export async function unlockWithAny(bytes: Uint8Array, passwords: readonly (string | null)[]): Promise<PdfText & { tried: number }> {
	let last: PdfText = { ok: false, reason: "needs_password", message: "no password is set for this bank" };
	let tried = 0;
	for (const pw of passwords.length ? passwords : [null]) {
		tried++;
		last = await readPdfText(bytes, pw);
		if (last.ok || (last.reason !== "wrong_password" && last.reason !== "needs_password")) break;
	}
	return { ...last, tried };
}
