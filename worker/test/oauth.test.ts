/// The whole worker as Cloudflare runs it (index.ts: the REAL OAuth library
/// wrapped around app.ts), and claude.ai's whole sign-in, step by step:
/// register → authorize → emailed code → verify → token → /mcp.
/// The library's KV is in memory; the email is caught, never sent.

import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import type { LedgerEnv } from "../src/env";
import { buildWorker } from "../src/index";
import { BASE, CTX, makeDeps, makeEnv, MemoryKV, OWNER, seedWorld, signedIn, TAP_KEY, TEST_ASSETS } from "./helpers/harness";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let db: TestDb;
let env: LedgerEnv & { OAUTH_KV: MemoryKV };
let deps: ReturnType<typeof makeDeps>;
let worker: ReturnType<typeof buildWorker>;

beforeEach(async () => {
	db = freshDb();
	await seedWorld(db);
	deps = makeDeps();
	env = { ...makeEnv(db), OAUTH_KV: new MemoryKV() };
	worker = buildWorker(deps, TEST_ASSETS);
});
afterEach(() => db.close());

const fetchWorker = (r: Request, e: LedgerEnv = env) => worker.fetch(r as never, e as never, { ...CTX } as never) as Promise<Response>;
const b64url = (b: Buffer) => b.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

function formPost(path: string, fields: Record<string, string>): Request {
	return new Request(BASE + path, { method: "POST", body: new URLSearchParams(fields) });
}

function hidden(html: string, name: string): string {
	const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
	if (!m) throw new Error(`no hidden ${name} in: ${html.slice(0, 300)}`);
	return m[1]!.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

async function register(): Promise<string> {
	const res = await fetchWorker(
		new Request(`${BASE}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
		}),
	);
	expect(res.status).toBe(201);
	return ((await res.json()) as { client_id: string }).client_id;
}

async function startAuthorize(clientId: string, method = "S256"): Promise<{ state: string; verifier: string; res: Response }> {
	const verifier = b64url(randomBytes(32));
	const challenge = method === "S256" ? b64url(createHash("sha256").update(verifier).digest()) : verifier;
	const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: method, state: "st-123", scope: "ledger:read ledger:write" });
	const res = await fetchWorker(new Request(`${BASE}/authorize?${q}`));
	const html = await res.clone().text();
	return { state: res.status === 200 ? hidden(html, "oauth") : "", verifier, res };
}

function codeFromMail(): string {
	const last = deps.mail.sent.at(-1)!;
	return /(\d{6})/.exec(last.subject)![1]!;
}

async function signInAll(): Promise<string> {
	const clientId = await register();
	const { state, verifier } = await startAuthorize(clientId);
	await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }));
	const done = await fetchWorker(formPost("/authorize/verify", { oauth: state, email: OWNER, code: codeFromMail() }));
	expect(done.status).toBe(302);
	const back = new URL(done.headers.get("Location")!);
	expect(back.origin + back.pathname).toBe(REDIRECT);
	expect(back.searchParams.get("state")).toBe("st-123");
	const token = await fetchWorker(
		formPost("/token", { grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
	);
	expect(token.status).toBe(200);
	return ((await token.json()) as { access_token: string }).access_token;
}

function mcp(token?: string): Request {
	return new Request(`${BASE}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
	});
}

describe("claude.ai connects, the way it does to the owner's other connectors", () => {
	it("discovers the sign-in: S256 PKCE only", async () => {
		const res = await fetchWorker(new Request(`${BASE}/.well-known/oauth-authorization-server`));
		expect(res.status).toBe(200);
		const meta = (await res.json()) as { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; code_challenge_methods_supported: string[] };
		expect(meta.authorization_endpoint).toBe(`${BASE}/authorize`);
		expect(meta.registration_endpoint).toBe(`${BASE}/register`);
		expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
	});

	it("/mcp without a token, or with a made-up one, is 401 — the answer that starts claude.ai's sign-in", async () => {
		for (const token of [undefined, "owner:fake:token"]) {
			const res = await fetchWorker(mcp(token));
			expect(res.status).toBe(401);
			expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
		}
	});

	it("register → authorize → emailed code → verify → token → the ten tools", async () => {
		const token = await signInAll();
		expect(deps.mail.sent).toHaveLength(1);
		expect(deps.mail.sent[0]).toMatchObject({ to: [OWNER], from: "Ledger <onboarding@resend.dev>" });
		expect(deps.mail.sent[0]!.text).toContain("Claude");
		const res = await fetchWorker(mcp(token));
		expect(res.status).toBe(200);
		const tools = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools;
		expect(tools).toHaveLength(10); // + ledger_categories (23 Oct 2026)
		// The code is spent: the sign-in table is empty again, and only its hash was ever kept.
		expect(await db.prepare("SELECT COUNT(*) AS n FROM login_codes").bind().first()).toEqual({ n: 0 });
	});

	it("refuses plain PKCE at the door", async () => {
		const { res } = await startAuthorize(await register(), "plain");
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(deps.mail.sent).toHaveLength(0);
	});
});

describe("only the owner gets in", () => {
	it("another address is told the same thing as the owner, and sent nothing", async () => {
		const { state } = await startAuthorize(await register());
		const res = await fetchWorker(formPost("/authorize/code", { oauth: state, email: "someone@else.example" }));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("If someone@else.example is the ledger owner's address");
		expect(deps.mail.sent).toHaveLength(0);
		const verify = await fetchWorker(formPost("/authorize/verify", { oauth: state, email: "someone@else.example", code: "000000" }));
		expect(await verify.text()).toContain("That code is not right");
	});

	it("a wrong code five times, and the code is dead even when the right one follows", async () => {
		const { state } = await startAuthorize(await register());
		await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }));
		const right = codeFromMail();
		const wrong = right === "000000" ? "111111" : "000000";
		for (let i = 0; i < 4; i++) expect(await (await fetchWorker(formPost("/authorize/verify", { oauth: state, email: OWNER, code: wrong }))).text()).toContain("not right");
		expect(await (await fetchWorker(formPost("/authorize/verify", { oauth: state, email: OWNER, code: wrong }))).text()).toContain("expired or had too many tries");
		const late = await fetchWorker(formPost("/authorize/verify", { oauth: state, email: OWNER, code: right }));
		expect(late.status).toBe(200);
		expect(await late.text()).toContain("expired or had too many tries");
	});

	it("a code lasts 10 minutes", async () => {
		const { state } = await startAuthorize(await register());
		await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }));
		deps.advance(10 * 60 * 1000 + 1);
		expect(await (await fetchWorker(formPost("/authorize/verify", { oauth: state, email: OWNER, code: codeFromMail() }))).text()).toContain("expired");
	});

	it("no second email within a minute", async () => {
		const { state } = await startAuthorize(await register());
		await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }));
		const again = await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }));
		expect(await again.text()).toContain("less than a minute ago");
		expect(deps.mail.sent).toHaveLength(1);
		deps.advance(61_000);
		await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }));
		expect(deps.mail.sent).toHaveLength(2);
	});

	it("the OAuth request carried between the screens cannot be altered", async () => {
		const { state } = await startAuthorize(await register());
		const [body, sig] = state.split(".");
		const forged = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
		forged.req.redirectUri = "https://evil.example/callback";
		const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
		const res = await fetchWorker(formPost("/authorize/code", { oauth: tampered, email: OWNER }));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Start again");
		expect(deps.mail.sent).toHaveLength(0);
	});

	it("says plainly when email or the owner is not set up, instead of failing silently", async () => {
		const { state } = await startAuthorize(await register());
		const noMail = await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }), { ...env, RESEND_API_KEY: undefined });
		expect(noMail.status).toBe(503);
		expect(await noMail.text()).toContain("RESEND_API_KEY");
		const noOwner = await fetchWorker(new Request(`${BASE}/authorize?client_id=x`), { ...env, LEDGER_OWNER_EMAIL: undefined });
		expect(noOwner.status).toBe(503);
		expect(await db.prepare("SELECT COUNT(*) AS n FROM login_codes").bind().first()).toEqual({ n: 0 });
		deps.failMail = true;
		const failed = await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }));
		expect(await failed.text()).toContain("could not be emailed just now");
		// A code that never arrived does not block the retry, which goes out at once.
		deps.failMail = false;
		const retry = await fetchWorker(formPost("/authorize/code", { oauth: state, email: OWNER }));
		expect(await retry.text()).toContain("a 6-digit code is on its way");
		expect(deps.mail.sent).toHaveLength(1);
	});
});

describe("the other two locks still work through the OAuth wrapper", () => {
	it("the page is locked, and opens with the cookie", async () => {
		expect((await fetchWorker(new Request(`${BASE}/`))).status).toBe(401);
		const res = await fetchWorker(new Request(`${BASE}/api/overview`, { headers: { Cookie: await signedIn() } }));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
	});

	it("the privacy policy is public through the wrapper too", async () => {
		const res = await fetchWorker(new Request(`${BASE}/privacy`));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Privacy policy");
	});

	it("the Apple Pay tap goes through on its own key (the wrapper does not take its Authorization header)", async () => {
		const res = await fetchWorker(
			new Request(`${BASE}/api/shortcut/tap`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAP_KEY}` },
				body: JSON.stringify({ card: "Test Rewards", merchant: "Bakery", amount: "S$3.20", timestamp: "2026-10-09T08:00:00+08:00" }),
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, status: "created" });
	});

	it("an OAuth token does not open the page's API", async () => {
		const token = await signInAll();
		const res = await fetchWorker(new Request(`${BASE}/api/overview`, { headers: { Authorization: `Bearer ${token}` } }));
		expect(res.status).toBe(401);
	});
});
