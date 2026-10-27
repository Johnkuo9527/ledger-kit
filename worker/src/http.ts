/// Responses. Every JSON answer is the §5.1 envelope: `{ ok: true, … }` or
/// `{ ok: false, message }`, and nothing else — a reader requires `ok === true`
/// (a lesson from an earlier project: a crash served as JSON had `ok` undefined, and a
/// guard that only looked for `ok === false` drew it as an empty month).

/// Never cache the owner's money: not a shared cache, not the back button.
const NO_STORE = "no-store, must-revalidate";

export const BASE_HEADERS: Readonly<Record<string, string>> = {
	"Cache-Control": NO_STORE,
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Opener-Policy": "same-origin",
};

/// For HTML. Design's page loads its own scripts and styles from this worker
/// and talks only to it. 'unsafe-inline' styles because a hand-built page
/// often sets a style attribute; scripts are same-origin files only.
export const PAGE_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"form-action 'self'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
	"object-src 'none'",
].join("; ");

export function json(body: object, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...headers },
	});
}

export function ok(payload: object = {}, status = 200): Response {
	return json({ ok: true, ...payload }, status);
}

export function fail(status: number, message: string, headers: Record<string, string> = {}): Response {
	return json({ ok: false, message }, status, headers);
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", ...BASE_HEADERS, "Content-Security-Policy": PAGE_CSP, ...headers },
	});
}

export function esc(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/// A request the worker understood and refused, with its status.
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/// The largest request body any route here accepts.
export const MAX_BODY_BYTES = 64 * 1024;

/// A JSON object body, `{}` for an empty one. Anything else is a 400.
export async function readJsonObject(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > maxBytes) throw new HttpError(413, "the request is too large");
	const text = await request.text();
	if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError(413, "the request is too large");
	if (!text.trim()) return {};
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new HttpError(400, "the body is not JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the body must be a JSON object");
	return body as Record<string, unknown>;
}
