/// The ledger worker . One worker, three locks, never confused:
///
///   /mcp                  OAuth — the owner's claude.ai, signed in by emailed code
///                         (sign-in.ts), the five tools in mcp.ts
///   /mcp-reader           OAuth, a READER token only — his Claude routines'
///                         reading desk (reader-mcp.ts, three tools)
///   /api/shortcut/tap     LEDGER_SHORTCUT_KEY — his iPhone's Apple Pay Shortcut
///   /api/shortcut/sms     LEDGER_SHORTCUT_KEY — a prepaid shop's SMS, sent on by his iPhone
///   everything else       the page cookie, traded for LEDGER_UNLOCK_KEY (app.ts)
///
/// The OAuth library (the same one, at the same version, as the owner's other
/// connectors) wraps the worker: it serves /token, /register and the
/// .well-known documents itself, refuses /mcp without a valid token (with the
/// 401 + discovery answer claude.ai expects), and hands every other request to
/// app.ts. S256 PKCE only.
///
/// The daily engine is the `scheduled` handler: Cloudflare runs it
/// every minute (wrangler.toml [triggers]) and tick.ts decides what, if
/// anything, there is to do.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { PAGE_ASSETS } from "../generated/page-assets";
import { handleRequest } from "./app";
import { realDeps, type Ctx, type LedgerEnv } from "./env";
import { handleMcp } from "./mcp";
import { handleReaderMcp } from "./reader-mcp";
import { SCOPES } from "./sign-in";
import { ENGINE_STEPS } from "./steps";
import { liveServices, runTick } from "./tick";

/// Exported so the tests can build the same worker with their own clock.
export function buildWorker(deps = realDeps, assets = PAGE_ASSETS) {
	return new OAuthProvider<LedgerEnv>({
		// "/mcp-reader" first: the library matches routes by prefix, in this order.
		apiHandlers: {
			"/mcp-reader": { fetch: (request: Request, env: LedgerEnv, ctx: Ctx) => handleReaderMcp(request, env, ctx, deps) } as never,
			"/mcp": { fetch: (request: Request, env: LedgerEnv, ctx: Ctx) => handleMcp(request, env, ctx, deps) } as never,
		},
		defaultHandler: { fetch: (request: Request, env: LedgerEnv, ctx: Ctx) => handleRequest(request, env, ctx, { assets, deps }) } as never,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register",
		scopesSupported: SCOPES,
		allowPlainPKCE: false,
		accessTokenTTL: 24 * 3600,
	});
}

const worker = buildWorker();

export default {
	fetch: (request: Request, env: LedgerEnv, ctx: Ctx) => (worker as unknown as { fetch(r: Request, e: LedgerEnv, c: Ctx): Promise<Response> }).fetch(request, env, ctx),
	scheduled: (_controller: unknown, env: LedgerEnv, ctx: Ctx) => ctx.waitUntil(runTick(env, realDeps, liveServices(env, realDeps), ENGINE_STEPS)),
};
