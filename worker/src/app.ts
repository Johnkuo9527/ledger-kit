/// The ledger worker's front door: every request that is not the OAuth
/// library's own (/token, /register, /.well-known/…) or the connector (/mcp)
/// lands here. index.ts wires the library around it.
///
///   POST /api/shortcut/tap        Apple Pay taps — its OWN bearer key (tap.ts)
///   POST /api/shortcut/sms        a prepaid shop's SMS — the same bearer key (sms.ts)
///   POST /api/statements/share    a statement PDF from the iPhone Share Sheet — the same key (uploads.ts)
///   GET|POST /unlock, POST /signout  the page's lock
///   GET /privacy                  the privacy policy — PUBLIC, fixed text (Google requires it)
///   /authorize, /authorize/*      the connector's sign-in screens (sign-in.ts)
///   GET /google/connect, /google/callback  「連接 Gmail」 — needs the page cookie (google.ts)
///   /api/*                        the page's API — needs the page cookie
///   everything else               Design's page — needs the page cookie
///
/// ⚠️ NO ROUTE ANSWERS WITHOUT ITS LOCK (but /privacy, which holds no data). An unknown /api address without the
/// cookie is a 401, not a 404, so a stranger cannot even map the API; an
/// unknown page address is the lock screen.

import { smsRoute } from "./sms";
import { isRefused } from "../../src/refused";
import { api } from "./api";
import { NOT_SET_UP, strongSecret, useHome, type Ctx, type Deps, type LedgerEnv } from "./env";
import { googleRoute } from "./google";
import { fail, HttpError } from "./http";
import { makeOp } from "./ops";
import { servePage, type PageAssets } from "./page";
import { lockScreen, privacyScreen, problemScreen } from "./screens";
import { checkSession, clearCookie, keyIsRight, mintCookie } from "./session";
import { signIn } from "./sign-in";
import { tapRoute } from "./tap";
import { shareRoute } from "./uploads";

export interface App {
	assets: PageAssets;
	deps: Deps;
}

/// A wrong key costs this long, every time. No counter and no lockout on
/// purpose: on a one-person page a lockout is a way for a stranger to lock
/// The owner out.
export const WRONG_KEY_DELAY_MS = 400;

async function unlock(env: LedgerEnv, app: App, given: string | null): Promise<Response> {
	if (!strongSecret(env.LEDGER_UNLOCK_KEY) || !strongSecret(env.LEDGER_SESSION_SECRET)) {
		return lockScreen("This ledger has not been given its key yet. The go-live checklist says how.", "bad");
	}
	if (!given) return lockScreen("Paste your key to open your ledger.");
	if (!(await keyIsRight(given, env.LEDGER_UNLOCK_KEY))) {
		await app.deps.sleep(WRONG_KEY_DELAY_MS);
		return lockScreen("That key does not open this ledger. Check you used the whole link.", "bad");
	}
	// The redirect takes the key out of the address bar, so the link is not
	// left in his history, a screen share, or the referrer of what he opens next.
	return new Response(null, {
		status: 303,
		headers: { Location: "/", "Set-Cookie": await mintCookie(env.LEDGER_SESSION_SECRET, app.deps.now()), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
}

/// Another site cannot make the owner's browser change his ledger: the cookie is
/// SameSite=Lax (so a cross-site POST arrives without it), and a write whose
/// browser says it came from elsewhere is refused outright as well.
function crossSite(request: Request, url: URL): boolean {
	const site = request.headers.get("Sec-Fetch-Site");
	if (site && site !== "same-origin" && site !== "none") return true;
	const origin = request.headers.get("Origin");
	return !!origin && origin !== url.origin;
}

async function apiRoute(request: Request, url: URL, env: LedgerEnv, app: App): Promise<Response> {
	if ((await checkSession(request, env.LEDGER_SESSION_SECRET, app.deps.now())) !== "valid") return fail(401, "not signed in");
	if (request.method !== "GET" && request.method !== "HEAD" && crossSite(request, url)) return fail(403, "refused: this change did not come from your ledger page");
	try {
		const op = await makeOp(env, app.deps, "owner");
		const res = await api(op, request, url);
		return res ?? fail(404, "no such address");
	} catch (e) {
		if (isRefused(e)) return fail(400, e.message);
		if (e instanceof HttpError) return fail(e.status, e.message);
		console.error("ledger api failed", e);
		return fail(500, "the ledger could not answer just now");
	}
}

export async function handleRequest(request: Request, env: LedgerEnv, _ctx: Ctx, app: App): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const notSetUp = useHome(env);
	if (notSetUp) return new Response(NOT_SET_UP(notSetUp), { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
	try {
		if (path === "/api/shortcut/tap") return await tapRoute(request, env, app.deps);
		if (path === "/api/shortcut/sms") return await smsRoute(request, env, app.deps);
		if (path === "/api/statements/share") return await shareRoute(request, env, app.deps);

		// Public on purpose, and the ONLY public page: fixed text, not one byte of the ledger.
		if (path === "/privacy" && (request.method === "GET" || request.method === "HEAD")) return privacyScreen();

		if (path === "/unlock") {
			if (request.method === "GET") return await unlock(env, app, url.searchParams.get("key"));
			if (request.method === "POST") {
				const form = await request.formData().catch(() => null);
				const key = form?.get("key");
				return await unlock(env, app, typeof key === "string" ? key.trim() : null);
			}
			return lockScreen("Tap your ledger link, or paste your key.");
		}

		if (path === "/signout" && request.method === "POST") {
			const page = lockScreen("Signed out. Tap your link again whenever you want your ledger back.");
			const headers = new Headers(page.headers);
			headers.append("Set-Cookie", clearCookie());
			return new Response(page.body, { status: page.status, headers });
		}

		if (path === "/authorize" || path.startsWith("/authorize/")) return await signIn(request, env, app.deps);

		if (path === "/api" || path.startsWith("/api/")) return await apiRoute(request, url, env, app);

		// The page's own lock (a stranger gets the lock screen, 401) — then Google.
		if (path === "/google" || path.startsWith("/google/")) return await googleRoute(request, url, env, app.deps);

		const state = await checkSession(request, env.LEDGER_SESSION_SECRET, app.deps.now());
		if (state !== "valid") {
			return lockScreen(state === "stale" ? "This browser has been signed in a long time and needs your key again." : "Tap your ledger link, or paste your key.");
		}
		return servePage(app.assets, url, request.method);
	} catch (e) {
		console.error("ledger worker failed", e);
		return path.startsWith("/api/") ? fail(500, "the ledger could not answer just now") : problemScreen("Something went wrong", "Try again in a minute.", 500);
	}
}
