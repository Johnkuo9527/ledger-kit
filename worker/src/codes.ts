/// The 6-digit sign-in code for the claude.ai connector — the same rules as
/// The owner's other connectors: only a hash is stored, 10 minutes, 5 tries, then a
/// fresh code. One more rule here: no second code within a minute, so nobody
/// can fill the owner's inbox by pressing "send" over and over.

import type { Db } from "../../src/db";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_GAP_MS = 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeEmail(raw: string | null | undefined): string | null {
	const e = (raw ?? "").trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

/// A fresh code, or "wait" when one went out less than a minute ago.
export async function createLoginCode(db: Db, email: string, nowMs: number): Promise<string | "wait"> {
	const last = await db.prepare("SELECT sent_at FROM login_codes WHERE email = ?").bind(email).first<{ sent_at: number }>();
	if (last && nowMs - last.sent_at < RESEND_GAP_MS) return "wait";
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	const code = String(buf[0]! % 1_000_000).padStart(6, "0");
	await db
		.prepare(
			"INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?) " +
				"ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at",
		)
		.bind(email, await sha256Hex(`${email}:${code}`), nowMs + CODE_TTL_MS, nowMs)
		.run();
	return code;
}

export type VerifyResult = "ok" | "wrong" | "expired";

export async function verifyLoginCode(db: Db, email: string, code: string, nowMs: number): Promise<VerifyResult> {
	const row = await db.prepare("SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?").bind(email).first<{ code_hash: string; expires_at: number; attempts: number }>();
	if (!row || row.expires_at < nowMs || row.attempts >= MAX_ATTEMPTS) return "expired";
	// Count the try BEFORE comparing, in the same statement that checks the cap,
	// so five guesses sent at once cannot all be judged on the old count.
	const counted = await db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ? AND attempts < ?").bind(email, MAX_ATTEMPTS).run();
	if (counted.meta.changes !== 1) return "expired";
	if ((await sha256Hex(`${email}:${code.trim()}`)) !== row.code_hash) return row.attempts + 1 >= MAX_ATTEMPTS ? "expired" : "wrong";
	// Used once: deleting it is what makes a replay fail.
	const used = await db.prepare("DELETE FROM login_codes WHERE email = ? AND code_hash = ?").bind(email, row.code_hash).run();
	return used.meta.changes === 1 ? "ok" : "expired";
}

/// A code that never reached the inbox must not count as sent: otherwise the
/// one-minute gap would refuse the retry and tell the owner to use a code he never got.
export async function forgetLoginCode(db: Db, email: string): Promise<void> {
	await db.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();
}
