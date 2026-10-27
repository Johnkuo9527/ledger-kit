/// Signing the owner's claude.ai in to the ledger connector: claude.ai
/// registers itself and sends him to /authorize; he gives his email, gets a
/// 6-digit code, types it, and the OAuth library (S256 PKCE only) hands
/// claude.ai a token for /mcp.
///
///   GET  /authorize          the email box
///   POST /authorize/code     sends the code — only ever to LEDGER_OWNER_EMAIL
///   POST /authorize/verify   checks it, completes the authorisation, redirects
///
/// Two things differ from the multi-user connectors, both because this ledger
/// is ONE person's money:
///   * only the owner's address is sent a code; any other address gets the
///     same "a code is on its way if this is the owner" screen and no email;
///   * the OAuth request carried between the screens is SIGNED, so it cannot
///     be altered in the hidden form field between one step and the next.

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createLoginCode, forgetLoginCode, normalizeEmail, verifyLoginCode } from "./codes";
import { strongSecret, type Deps, type LedgerEnv } from "./env";
import { sendMail } from "./mail";
import { problemScreen, signInCodeScreen, signInEmailScreen } from "./screens";
import { openValue, sealValue } from "./session";

/// Which connector a sign-in is for (13 Oct 2026): claude.ai names
/// the server it is connecting to in the OAuth `resource` parameter (RFC 8707,
/// required by MCP). /mcp-reader → a READER grant (props.aud "reader"), usable
/// only at /mcp-reader; anything else → the ledger's own (/mcp), as before.
/// The OAuth library also binds the token to that resource, so each token is
/// refused at the other address twice over.
export function audienceOf(req: Pick<AuthRequest, "resource">): "ledger" | "reader" {
	const list = Array.isArray(req.resource) ? req.resource : req.resource ? [req.resource] : [];
	return list.some((r) => {
		try {
			return new URL(r).pathname.replace(/\/+$/, "") === "/mcp-reader";
		} catch {
			return false;
		}
	})
		? "reader"
		: "ledger";
}

const CONNECTOR_NAME = { ledger: "your ledger", reader: "your ledger's reading desk (Ledger Reader)" } as const;

/// Everyone who signs in is the owner, so there is one user id.
export const OWNER_USER_ID = "owner";
export const SCOPES = ["ledger:read", "ledger:write"];

const STATE_PURPOSE = "oauth-request.v1";

interface FlowState {
	req: AuthRequest;
	clientName: string;
}

type SignInEnv = LedgerEnv & { OAUTH_PROVIDER?: OAuthHelpers };

export function ownerEmail(env: LedgerEnv): string | null {
	return normalizeEmail(env.LEDGER_OWNER_EMAIL);
}

export async function signIn(request: Request, env: SignInEnv, deps: Deps): Promise<Response> {
	const url = new URL(request.url);
	const oauth = env.OAUTH_PROVIDER;
	const owner = ownerEmail(env);
	if (!oauth || !owner || !strongSecret(env.LEDGER_SESSION_SECRET)) {
		return problemScreen("Not set up yet", "This ledger's connector has not been given its owner's email and secrets yet. The go-live checklist says how.", 503);
	}
	const secret = env.LEDGER_SESSION_SECRET;
	const open = async (form: FormData) => openValue<FlowState>(secret, STATE_PURPOSE, String(form.get("oauth") ?? ""));
	const startOver = () => problemScreen("Start again", "Something went wrong. Start again from your connector settings in Claude.", 400);

	if (url.pathname === "/authorize" && request.method === "GET") {
		let req: AuthRequest;
		try {
			req = await oauth.parseAuthRequest(request);
		} catch {
			return problemScreen("Start again", "That sign-in link is not valid. Start again from your connector settings in Claude.", 400);
		}
		const client = await oauth.lookupClient(req.clientId);
		if (!client) return startOver();
		const clientName = client.clientName || "An AI assistant";
		return signInEmailScreen(await sealValue(secret, STATE_PURPOSE, { req, clientName }), clientName, null);
	}

	if (url.pathname === "/authorize/code" && request.method === "POST") {
		const form = await request.formData();
		const raw = String(form.get("oauth") ?? "");
		const state = await open(form);
		if (!state) return startOver();
		const email = normalizeEmail(String(form.get("email") ?? ""));
		if (!email) return signInEmailScreen(raw, state.clientName, "That does not look like an email address. Try again.");
		if (email !== owner) return signInCodeScreen(raw, email, null, null);
		if (!env.RESEND_API_KEY) return problemScreen("Email is not set up", "The ledger cannot send the code because its email key (RESEND_API_KEY) is not set yet. The go-live checklist says how.", 503);
		const code = await createLoginCode(env.LEDGER_DB, email, deps.now().getTime());
		if (code === "wait") return signInCodeScreen(raw, email, "A code went out less than a minute ago. Use that one, or wait a minute and start again.", null);
		const sent = await sendMail(env, deps, {
			to: email,
			subject: `Your ledger sign-in code: ${code}`,
			text: `Your code to connect ${state.clientName} to ${CONNECTOR_NAME[audienceOf(state.req)]} is ${code}.\n\nIt lasts 10 minutes. If you did not ask for it, ignore this email: nothing is connected without the code.`,
		});
		if (sent !== "sent") {
			await forgetLoginCode(env.LEDGER_DB, email);
			return signInEmailScreen(raw, state.clientName, "The code could not be emailed just now. Try again in a minute.");
		}
		return signInCodeScreen(raw, email, null, null);
	}

	if (url.pathname === "/authorize/verify" && request.method === "POST") {
		const form = await request.formData();
		const raw = String(form.get("oauth") ?? "");
		const state = await open(form);
		if (!state) return startOver();
		const email = normalizeEmail(String(form.get("email") ?? ""));
		if (!email) return signInEmailScreen(raw, state.clientName, "Start again with your email.");
		const result = email === owner ? await verifyLoginCode(env.LEDGER_DB, email, String(form.get("code") ?? ""), deps.now().getTime()) : "wrong";
		if (result === "wrong") return signInCodeScreen(raw, email, null, "That code is not right. Check it and try again.");
		if (result === "expired") return signInEmailScreen(raw, state.clientName, "That code has expired or had too many tries. Enter your email for a fresh one.");
		const { redirectTo } = await oauth.completeAuthorization({
			request: state.req,
			userId: OWNER_USER_ID,
			metadata: { email },
			scope: SCOPES,
			props: { email, aud: audienceOf(state.req) },
		});
		return Response.redirect(redirectTo, 302);
	}

	return problemScreen("Not found", "There is nothing at this address.", 404);
}
