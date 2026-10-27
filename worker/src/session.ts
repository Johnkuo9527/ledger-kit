/// The lock on the ledger page — a simple lock:
/// a long random key the owner holds in a link he taps once, traded for a signed
/// cookie. No password, no email, and nothing secret ever reaches the page.
///
/// The cookie is stateless: its expiry and an HMAC of that expiry. Nothing is
/// stored, so there is no session table to leak, and signing every browser out
/// is one command (rotate LEDGER_SESSION_SECRET).
///
/// ⚠️ THE COOKIE NAME MUST STAY UNIQUE among all the workers on
/// one *.workers.dev subdomain (each keeps its own). This one is `ledger_sid`.
///
/// ⚠️ THIS LOCK IS NOT THE CONNECTOR'S LOCK. /mcp is OAuth (src/sign-in.ts) and
/// /api/shortcut/tap is its own bearer key. The cookie proves one thing only —
/// whoever holds it holds the owner's page key — and is accepted nowhere else.

import { strongSecret } from "./env";

export const COOKIE = "ledger_sid";

/// One tap of the unlock link keeps a browser signed in this long. Shorter than
/// The owner's other boards (180 days) because this one is money.
export const SESSION_DAYS = 90;

function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/// Compared as digests, so a wrong guess costs the same whatever its length.
export async function keyIsRight(given: string, expected: string | undefined): Promise<boolean> {
	if (!strongSecret(expected) || !given) return false;
	const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
	return sameText(a, b);
}

export function readCookie(request: Request, name: string): string | null {
	const raw = request.headers.get("Cookie");
	if (!raw) return null;
	for (const part of raw.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

export type SessionState = "none" | "valid" | "stale";

export async function checkSession(request: Request, secret: string | undefined, now: Date): Promise<SessionState> {
	if (!strongSecret(secret)) return "none";
	const raw = readCookie(request, COOKIE);
	if (!raw) return "none";
	const bits = raw.split(".");
	if (bits.length !== 3 || bits[0] !== "v1" || !/^\d+$/.test(bits[1]!)) return "none";
	const expected = await hmacHex(secret, `session.v1.${bits[1]}`);
	if (!sameText(bits[2]!, expected)) return "none";
	// Signed but out of time: "stale", so the lock page can say why.
	return now.getTime() < Number(bits[1]) ? "valid" : "stale";
}

export async function mintCookie(secret: string, now: Date, days: number = SESSION_DAYS): Promise<string> {
	const expires = now.getTime() + days * 86_400_000;
	const value = `v1.${expires}.${await hmacHex(secret, `session.v1.${expires}`)}`;
	// HttpOnly: no script on the page can read it. Secure: never over plain
	// HTTP. SameSite=Lax: another site cannot make the owner's browser POST here
	// with it attached.
	return `${COOKIE}=${value}; Path=/; Max-Age=${days * 86_400}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(): string {
	return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// ------------------------------------------------- signed hand-offs

/// A value carried through a form (the OAuth request between the sign-in
/// pages) and signed, so it cannot be altered in between. `purpose` keeps a
/// signature made for one thing from being replayed as another.
function toBase64Url(text: string): string {
	let bin = "";
	for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(text: string): string {
	const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function sealValue(secret: string, purpose: string, value: unknown): Promise<string> {
	const body = toBase64Url(JSON.stringify(value));
	return `${body}.${await hmacHex(secret, `${purpose}.${body}`)}`;
}

export async function openValue<T>(secret: string, purpose: string, sealed: string): Promise<T | null> {
	const dot = sealed.lastIndexOf(".");
	if (dot < 1) return null;
	const body = sealed.slice(0, dot);
	if (!sameText(sealed.slice(dot + 1), await hmacHex(secret, `${purpose}.${body}`))) return null;
	try {
		return JSON.parse(fromBase64Url(body)) as T;
	} catch {
		return null;
	}
}
