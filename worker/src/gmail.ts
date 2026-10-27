/// Reading the owner's one Gmail account, read-only (scope gmail.readonly), through
/// the Gmail REST API. The Google client is two worker secrets,
/// GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET; the refresh token is the one the owner
/// saved with 「連接 Gmail」 on his page (stored encrypted, google.ts →
/// gmailFromLink picks it), or — the old Playground way, now only a
/// fallback — the secret GMAIL_REFRESH_TOKEN.
///
/// A refresh token that Google has revoked or expired answers `invalid_grant`
/// — that is the "Google sign-in failed" alarm, never a silent stop. (A Google
/// Cloud app left in "Testing" expires its refresh tokens after 7 days; the
/// INSTALL.md insists on "In production" for exactly this reason.)

import { authenticatedDomains } from "./banks";
import type { Deps } from "./env";

export interface GmailSecrets {
	GMAIL_CLIENT_ID?: string;
	GMAIL_CLIENT_SECRET?: string;
	GMAIL_REFRESH_TOKEN?: string;
}

export class GmailError extends Error {
	constructor(
		readonly kind: "not_set_up" | "signin_failed" | "unavailable" | "refused",
		message: string,
	) {
		super(message);
	}
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GmailPart {
	partId?: string;
	mimeType?: string;
	filename?: string;
	headers?: { name: string; value: string }[];
	body?: { size?: number; data?: string; attachmentId?: string };
	parts?: GmailPart[];
}
export interface GmailMessage {
	id: string;
	threadId?: string;
	internalDate?: string; // ms since the epoch, as a string
	payload?: GmailPart;
}

/// One email, reduced to what the ledger reads.
export interface Mail {
	id: string;
	thread_id: string | null;
	from: string;
	subject: string;
	headers: Record<string, string>;
	/// The domains Gmail's own Authentication-Results header vouches for
	/// (DMARC or DKIM pass) — see banks.ts. Empty = nothing vouched for.
	auth: string[];
	received_at: string; // ISO timestamp
	text: string; // plain text (HTML stripped when there is no text part)
	pdfs: { filename: string; attachment_id: string; size: number }[];
}

export class Gmail {
	private token: { value: string; expires: number } | null = null;
	constructor(
		private secrets: GmailSecrets,
		private deps: Pick<Deps, "fetch" | "now">,
	) {}

	private async accessToken(): Promise<string> {
		const now = this.deps.now().getTime();
		if (this.token && this.token.expires > now + 60_000) return this.token.value;
		const { GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret, GMAIL_REFRESH_TOKEN: refresh } = this.secrets;
		if (!id || !secret || !refresh) throw new GmailError("not_set_up", "the Gmail sign-in secrets are not set yet");
		let res: Response;
		try {
			res = await this.deps.fetch(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
			});
		} catch {
			throw new GmailError("unavailable", "Google could not be reached");
		}
		const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
		if (!res.ok || !body.access_token) {
			if (body.error === "invalid_grant" || body.error === "invalid_client" || body.error === "unauthorized_client" || res.status === 400 || res.status === 401)
				throw new GmailError("signin_failed", `Google refused the ledger's sign-in (${body.error ?? res.status}); the owner needs to sign in again`);
			throw new GmailError("unavailable", `Google's sign-in answered ${res.status}`);
		}
		this.token = { value: body.access_token, expires: now + (body.expires_in ?? 3600) * 1000 };
		return this.token.value;
	}

	private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
		const qs = new URLSearchParams(params).toString();
		let res: Response;
		try {
			res = await this.deps.fetch(`${API}${path}${qs ? `?${qs}` : ""}`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
		} catch (e) {
			if (e instanceof GmailError) throw e;
			throw new GmailError("unavailable", "Gmail could not be reached");
		}
		if (res.status === 401) {
			this.token = null;
			throw new GmailError("signin_failed", "Gmail refused the ledger's access token");
		}
		if (res.status === 429 || res.status >= 500) throw new GmailError("unavailable", `Gmail answered ${res.status}`);
		if (!res.ok) throw new GmailError("refused", `Gmail refused ${path.split("/")[1]}: ${res.status}`);
		return (await res.json()) as T;
	}

	/// One page of message ids for a search (Gmail's own search syntax).
	async list(q: string, pageToken?: string, max = 100): Promise<{ ids: string[]; next: string | null }> {
		const r = await this.get<{ messages?: { id: string }[]; nextPageToken?: string }>("/messages", { q, maxResults: String(max), ...(pageToken ? { pageToken } : {}) });
		return { ids: (r.messages ?? []).map((m) => m.id), next: r.nextPageToken ?? null };
	}

	async message(id: string): Promise<Mail> {
		return toMail(await this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}`, { format: "full" }));
	}

	async attachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
		const r = await this.get<{ data?: string }>(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
		return base64UrlBytes(r.data ?? "");
	}
}

export function base64UrlBytes(data: string): Uint8Array {
	const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeText(part: GmailPart): string {
	if (!part.body?.data) return "";
	const bytes = base64UrlBytes(part.body.data);
	const ct = part.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
	const charset = /charset="?([^";]+)"?/i.exec(ct)?.[1]?.toLowerCase() ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
		.replace(/<\/t[dh]>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
}

export function toMail(m: GmailMessage): Mail {
	const headers: Record<string, string> = {};
	for (const h of m.payload?.headers ?? []) headers[h.name] = h.value;
	// In order, topmost first: only the topmost (Gmail's own) one counts.
	const authResults = (m.payload?.headers ?? []).filter((h) => h.name.toLowerCase() === "authentication-results").map((h) => h.value);
	const plain: string[] = [];
	const html: string[] = [];
	const pdfs: Mail["pdfs"] = [];
	const walk = (p: GmailPart) => {
		const type = (p.mimeType ?? "").toLowerCase();
		const isPdf = type === "application/pdf" || (type === "application/octet-stream" && /\.pdf$/i.test(p.filename ?? ""));
		if (p.filename && p.body?.attachmentId) {
			if (isPdf) pdfs.push({ filename: p.filename, attachment_id: p.body.attachmentId, size: p.body.size ?? 0 });
		} else if (type === "text/plain") plain.push(decodeText(p));
		else if (type === "text/html") html.push(decodeText(p));
		for (const c of p.parts ?? []) walk(c);
	};
	if (m.payload) walk(m.payload);
	const get = (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
	return {
		id: m.id,
		thread_id: m.threadId ?? null,
		from: get("from"),
		subject: get("subject"),
		headers,
		auth: authenticatedDomains(authResults),
		received_at: new Date(Number(m.internalDate ?? 0)).toISOString(),
		text: plain.length ? plain.join("\n").trim() : htmlToText(html.join("\n")),
		pdfs,
	};
}
