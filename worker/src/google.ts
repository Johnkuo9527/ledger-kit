/// 「連接 Gmail」: the owner connects his Gmail from his own locked page, in one tap,
/// instead of copying a refresh token out of Google's OAuth Playground.
///
///   GET /google/connect   → Google's consent screen (gmail.readonly ONLY,
///                           offline, PKCE S256, a signed 10-minute `state`
///                           bound to this browser's page session)
///   GET /google/callback  → checks that state, trades the code for tokens,
///                           checks Gmail read access was really granted,
///                           asks Gmail which mailbox it is, keeps the refresh
///                           token ENCRYPTED, and shows "Gmail connected: x@gmail.com" (say page.gmail.connected)
///
/// Both need the page cookie (app.ts sends a stranger the lock screen, 401).
/// The redirect URI is this worker's own `https://<host>/google/callback`; it
/// must be listed on the Google client (INSTALL.md step 6).
///
/// WHERE THE TOKEN LIVES. One row of sync_state, key `google_link`:
///   { v: 1, email, token: "<iv>.<ciphertext>", connected_at }
/// AES-GCM-256 with a key derived (HKDF-SHA256) from LEDGER_SESSION_SECRET, the
/// mailbox address as the additional data. Why that secret and not a new one:
/// The owner sets nothing extra; the database alone (an export, the dashboard) is
/// useless without the worker's secret; and rotating it — the lost-phone plan
/// that signs every browser out — also retires the Gmail grant, which is then
/// the `google_signin` alarm and one tap to reconnect. The token is never
/// logged, never put in a response, and never leaves this file in clear except
/// to Google's token endpoint.
///
/// gmail.ts's reader uses the stored token first and GMAIL_REFRESH_TOKEN (the
/// old Playground way) only when nothing is stored (gmailFromLink below).

import { say } from "../../src/words";
import type { Db } from "../../src/db";
import { clearAlarm } from "./alarms";
import { strongSecret, type Deps, type LedgerEnv } from "./env";
import { Gmail, GmailError } from "./gmail";
import { gmailDoneScreen, gmailProblemScreen, lockScreen, problemScreen } from "./screens";
import { checkSession, COOKIE, openValue, readCookie, sealValue } from "./session";
import type { MailSource } from "./tick";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/// The sync_state key holding the encrypted connection.
export const LINK_KEY = "google_link";
/// Carries the PKCE verifier from /google/connect to /google/callback. Unique
/// among the owner's workers on the shared workers.dev domain (see session.ts).
export const PKCE_COOKIE = "ledger_goog";
/// How long the owner has between tapping 「連接 Gmail」 and pressing Allow.
export const STATE_TTL_MS = 10 * 60_000;
const CALLBACK = "/google/callback";

// ------------------------------------------------------------------ bytes

const enc = (s: string) => new TextEncoder().encode(s);

function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromB64url(text: string): Uint8Array {
	const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
	return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", enc(text)));
}

// ------------------------------------------------------------------ the token at rest

async function tokenKey(secret: string): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
	const base = await crypto.subtle.importKey("raw", enc(secret), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: enc("ledger.google-link.v1"), info: enc("gmail refresh token at rest") },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

const aad = (email: string) => enc(`google_link.v1|${email}`);

export async function sealToken(secret: string, token: string, email: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(email) }, await tokenKey(secret), enc(token));
	return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

/// null when it cannot be opened (another secret, a changed row, garbage).
export async function openToken(secret: string, sealed: string, email: string): Promise<string | null> {
	const [iv, ct, extra] = sealed.split(".");
	if (!iv || !ct || extra !== undefined) return null;
	try {
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: aad(email) }, await tokenKey(secret), fromB64url(ct));
		const token = new TextDecoder().decode(pt);
		return token || null;
	} catch {
		return null;
	}
}

export interface GoogleLink {
	v: 1;
	email: string;
	token: string;
	connected_at: string;
}

export function parseLink(raw: string | null | undefined): GoogleLink | null {
	if (!raw) return null;
	try {
		const l = JSON.parse(raw) as Partial<GoogleLink>;
		return l && l.v === 1 && typeof l.email === "string" && typeof l.token === "string" && typeof l.connected_at === "string" ? (l as GoogleLink) : null;
	} catch {
		return null;
	}
}

async function readLinkRow(db: Db): Promise<string | null> {
	return (await db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(LINK_KEY).first<{ value: string }>())?.value ?? null;
}

// ------------------------------------------------------------------ the reader's token

/// A saved connection that can no longer be opened (LEDGER_SESSION_SECRET was
/// rotated) and no old-style secret to fall back on: every call is the
/// sign-in alarm, so the owner is told to reconnect instead of the reading going quiet.
class UnreadableLink implements MailSource {
	private fail(): never {
		throw new GmailError("signin_failed", "the saved Gmail connection can no longer be unlocked (the ledger's secret changed); reconnect Gmail");
	}
	async list(): Promise<{ ids: string[]; next: string | null }> {
		this.fail();
	}
	async message(): Promise<never> {
		this.fail();
	}
	async attachment(): Promise<Uint8Array> {
		this.fail();
	}
}

/// The Gmail reader for one tick: the token saved by 「連接 Gmail」 first, else
/// GMAIL_REFRESH_TOKEN, else none (Gmail work waits, as before). `raw` is the
/// google_link row the tick already loaded with the rest of sync_state.
export async function gmailFromLink(env: LedgerEnv, deps: Pick<Deps, "fetch" | "now">, raw: string | undefined): Promise<MailSource | null> {
	const id = env.GMAIL_CLIENT_ID;
	const secret = env.GMAIL_CLIENT_SECRET;
	if (!id || !secret) return null;
	const link = parseLink(raw);
	if (link) {
		const token = strongSecret(env.LEDGER_SESSION_SECRET) ? await openToken(env.LEDGER_SESSION_SECRET, link.token, link.email) : null;
		if (token) return new Gmail({ GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret, GMAIL_REFRESH_TOKEN: token }, deps);
		if (!env.GMAIL_REFRESH_TOKEN) return new UnreadableLink();
	}
	return env.GMAIL_REFRESH_TOKEN ? new Gmail({ GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret, GMAIL_REFRESH_TOKEN: env.GMAIL_REFRESH_TOKEN }, deps) : null;
}

/// What the page's status shows. Never the token.
export interface GmailLinkStatus {
	/// The Google client (GMAIL_CLIENT_ID and _SECRET) is set, so the button can work.
	ready: boolean;
	/// "page": connected with 「連接 Gmail」; "secret": the old GMAIL_REFRESH_TOKEN; null: not connected.
	via: "page" | "secret" | null;
	email: string | null;
	connected_at: string | null;
}

export async function gmailLinkStatus(env: LedgerEnv, db: Db): Promise<GmailLinkStatus> {
	const ready = !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET);
	const link = parseLink(await readLinkRow(db));
	if (link && strongSecret(env.LEDGER_SESSION_SECRET) && (await openToken(env.LEDGER_SESSION_SECRET, link.token, link.email)))
		return { ready, via: "page", email: link.email, connected_at: link.connected_at };
	if (env.GMAIL_REFRESH_TOKEN) return { ready, via: "secret", email: null, connected_at: null };
	return { ready, via: null, email: null, connected_at: null };
}

// ------------------------------------------------------------------ the two routes

interface StateBody {
	n: string; // nonce, also in the PKCE cookie
	e: number; // expires, ms
	s: string; // which page session started it
}
interface JarBody {
	n: string;
	v: string; // the PKCE code verifier
	e: number;
}

/// Binds the state to this browser's page cookie: a callback carried to
/// another browser (or a cookie minted later) does not match.
async function sessionTag(request: Request): Promise<string> {
	return b64url((await sha256(`google.session|${readCookie(request, COOKIE) ?? ""}`)).slice(0, 16));
}

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const jarCookie = (value: string, maxAge: number) => `${PKCE_COOKIE}=${value}; Path=/google/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function withHeaders(res: Response, extra: Record<string, string>): Response {
	const headers = new Headers(res.headers);
	for (const [k, v] of Object.entries(extra)) headers.append(k, v);
	return new Response(res.body, { status: res.status, headers });
}

export async function googleRoute(request: Request, url: URL, env: LedgerEnv, deps: Deps): Promise<Response> {
	const session = await checkSession(request, env.LEDGER_SESSION_SECRET, deps.now());
	if (session !== "valid") return lockScreen(`Open your ledger with your key first, then tap ${say("ui.connect_gmail")} again.`);
	if (request.method !== "GET") return problemScreen("Not allowed", "This address only takes a tap from your ledger page.", 405);
	if (url.pathname === "/google/connect") return connect(request, url, env, deps);
	if (url.pathname === CALLBACK) return withHeaders(await callback(request, url, env, deps), { "Set-Cookie": jarCookie("", 0) });
	return problemScreen("Not found", "There is nothing at this address.", 404);
}

async function connect(request: Request, url: URL, env: LedgerEnv, deps: Deps): Promise<Response> {
	const secret = env.LEDGER_SESSION_SECRET!; // checkSession said "valid", so it is strong
	if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET)
		return gmailProblemScreen("Gmail is not set up yet", `Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first (go-live checklist, Part 2), then tap ${say("ui.connect_gmail")} again.`, 503);
	const n = random(24);
	const verifier = random(32); // 43 characters, inside RFC 7636's 43–128
	const e = deps.now().getTime() + STATE_TTL_MS;
	const state = await sealValue(secret, "google.state", { n, e, s: await sessionTag(request) } satisfies StateBody);
	const jar = await sealValue(secret, "google.pkce", { n, v: verifier, e } satisfies JarBody);
	const q = new URLSearchParams({
		client_id: env.GMAIL_CLIENT_ID,
		redirect_uri: `${url.origin}${CALLBACK}`,
		response_type: "code",
		scope: GMAIL_SCOPE,
		access_type: "offline",
		// consent: Google hands over a refresh token every time; select_account:
		// The owner picks the mailbox the bank emails go to, not whichever is signed in.
		prompt: "consent select_account",
		include_granted_scopes: "false",
		state,
		code_challenge: b64url(await sha256(verifier)),
		code_challenge_method: "S256",
	});
	return new Response(null, { status: 302, headers: { Location: `${AUTH_URL}?${q}`, "Set-Cookie": jarCookie(jar, STATE_TTL_MS / 1000), ...NO_STORE } });
}

/// The button is named in the owner's language (「連接 Gmail」 / "Connect Gmail").
const again = () => `Go back to your ledger and tap ${say("ui.connect_gmail")} again.`;

async function callback(request: Request, url: URL, env: LedgerEnv, deps: Deps): Promise<Response> {
	const secret = env.LEDGER_SESSION_SECRET!;
	const now = deps.now().getTime();
	const rawState = url.searchParams.get("state");
	const rawJar = readCookie(request, PKCE_COOKIE);
	const st = rawState ? await openValue<StateBody>(secret, "google.state", rawState) : null;
	const jar = rawJar ? await openValue<JarBody>(secret, "google.pkce", rawJar) : null;
	if (!st || !jar || typeof st.n !== "string" || st.n !== jar.n || !(st.e > now) || !(jar.e > now) || typeof jar.v !== "string" || st.s !== (await sessionTag(request)))
		return gmailProblemScreen("This Gmail sign-in has expired", `It took longer than 10 minutes, or it did not start from this ledger in this browser. ${again()}`, 400);

	const error = url.searchParams.get("error");
	if (error) {
		const said = /^[a-z_]{1,40}$/.test(error) ? error : "unknown";
		return gmailProblemScreen(
			"Gmail was not connected",
			said === "access_denied" ? `You did not allow it, so nothing changed. ${again()}` : `Google stopped the sign-in (${said}), so nothing changed. ${again()}`,
			400,
		);
	}
	const code = url.searchParams.get("code");
	if (!code || code.length > 2048) return gmailProblemScreen("Gmail was not connected", `Google did not send a sign-in code. ${again()}`, 400);
	if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) return gmailProblemScreen("Gmail is not set up yet", "Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first (go-live checklist, Part 2).", 503);

	// 1. The code for tokens (PKCE: only the browser that started this holds the verifier).
	let res: Response;
	try {
		res = await deps.fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: env.GMAIL_CLIENT_ID,
				client_secret: env.GMAIL_CLIENT_SECRET,
				redirect_uri: `${url.origin}${CALLBACK}`,
				grant_type: "authorization_code",
				code_verifier: jar.v,
			}).toString(),
		});
	} catch {
		return gmailProblemScreen("Google could not be reached", `Nothing changed. ${again()}`, 502);
	}
	const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; scope?: unknown; error?: unknown };
	if (!res.ok || typeof body.access_token !== "string") {
		const said = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : String(res.status);
		return gmailProblemScreen("Google did not accept the sign-in", `Google answered "${said}", so nothing changed. ${again()}`, 400);
	}
	// 2. Read access really granted (Google lets a person untick a box on the consent screen).
	const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/) : [];
	if (!scopes.includes(GMAIL_SCOPE))
		return gmailProblemScreen("Gmail was not connected", `Google did not give the ledger permission to read your Gmail — the box on Google's screen was probably left unticked. ${again()} Tick the box this time.`, 400);
	if (typeof body.refresh_token !== "string" || !body.refresh_token)
		return gmailProblemScreen("Gmail was not connected", `Google did not hand over a lasting sign-in, so nothing changed. ${again()}`, 400);

	// 3. Which mailbox it is, so the owner can see it is the one the bank emails go to.
	let email: string | null = null;
	try {
		const p = await deps.fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${body.access_token}` } });
		const profile = (await p.json().catch(() => ({}))) as { emailAddress?: unknown };
		if (p.ok && typeof profile.emailAddress === "string" && profile.emailAddress.length <= 320 && profile.emailAddress.includes("@")) email = profile.emailAddress;
	} catch {
		email = null;
	}
	if (!email) return gmailProblemScreen("Gmail was not connected", `Gmail would not say which mailbox this is, so nothing was saved. ${again()}`, 502);

	// 4. Kept encrypted; the sign-in alarm (if any) is answered.
	const link: GoogleLink = { v: 1, email, token: await sealToken(secret, body.refresh_token, email), connected_at: new Date(now).toISOString() };
	const at = new Date(now).toISOString();
	const db = env.LEDGER_DB;
	await db.batch([
		db
			.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
			.bind(LINK_KEY, JSON.stringify(link), at),
		clearAlarm(db, "google_signin", at),
	]);
	return gmailDoneScreen(email);
}
