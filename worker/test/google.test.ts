/// 「連接 Gmail」 (google.ts) against a MOCK Google: no real Google call is ever
/// made, and every address, code and token here is made up.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { handleRequest, type App } from "../src/app";
import type { LedgerEnv } from "../src/env";
import { GMAIL_SCOPE, gmailFromLink, LINK_KEY, openToken, PKCE_COOKIE, sealToken, STATE_TTL_MS } from "../src/google";
import { dailyPull } from "../src/pull";
import { liveServices, runTick } from "../src/tick";
import { BASE, CTX, get, makeDeps, makeEnv, SESSION_SECRET, signedIn, TEST_ASSETS } from "./helpers/harness";

const CLIENT = { GMAIL_CLIENT_ID: "made-up-client.apps.googleusercontent.com", GMAIL_CLIENT_SECRET: "made-up-client-secret" };
const REFRESH = "1//made-up-REFRESH-token-never-shown-anywhere";
const ACCESS = "ya29.made-up-ACCESS-token";
const MAILBOX = "owner.made.up@example.com";

interface Google {
	calls: { url: string; body: string; auth: string | null }[];
	token: () => Response;
	profile: () => Response;
	refresh: () => Response;
}

function mockGoogle(): Google {
	return {
		calls: [],
		token: () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: GMAIL_SCOPE, token_type: "Bearer" }),
		profile: () => Response.json({ emailAddress: MAILBOX, messagesTotal: 1 }),
		refresh: () => Response.json({ access_token: ACCESS, expires_in: 3599 }),
	};
}

let db: TestDb;
let env: LedgerEnv;
let g: Google;
let deps: ReturnType<typeof makeDeps>;
let app: App;
let cookie: string;
let logs: string[];

beforeEach(async () => {
	db = freshDb();
	env = makeEnv(db, CLIENT);
	g = mockGoogle();
	deps = makeDeps();
	deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const headers = new Headers(init?.headers);
		g.calls.push({ url, body: String(init?.body ?? ""), auth: headers.get("Authorization") });
		if (url === "https://oauth2.googleapis.com/token") return new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token" ? g.refresh() : g.token();
		if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return g.profile();
		if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")) return Response.json({ messages: [] });
		throw new Error(`test made an unexpected network call: ${url}`);
	}) as typeof fetch;
	app = { assets: TEST_ASSETS, deps };
	cookie = await signedIn();
	logs = [];
	for (const level of ["log", "info", "warn", "error", "debug"] as const)
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
		});
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

const send = (r: Request, e: LedgerEnv = env) => handleRequest(r, e, CTX, app);
const link = () => db.raw.prepare("SELECT value FROM sync_state WHERE key = ?").get(LINK_KEY) as { value: string } | undefined;
const jarFrom = (res: Response) => /ledger_goog=([^;]*)/.exec(res.headers.get("Set-Cookie") ?? "")?.[1] ?? "";

/// Tap 「連接 Gmail」: the redirect to Google, the state and the PKCE cookie.
async function startConnect(c = cookie): Promise<{ res: Response; google: URL; state: string; jar: string }> {
	const res = await send(get("/google/connect", c));
	const google = new URL(res.headers.get("Location") ?? "about:blank");
	return { res, google, state: google.searchParams.get("state") ?? "", jar: jarFrom(res) };
}

function callback(params: Record<string, string>, jar: string | null, c = cookie): Request {
	const qs = new URLSearchParams(params).toString();
	return get(`/google/callback?${qs}`, undefined, { Cookie: [c, jar !== null ? `${PKCE_COOKIE}=${jar}` : ""].filter(Boolean).join("; ") });
}

async function everything(res: Response): Promise<string> {
	return `${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${await res.text()}`;
}

describe("the lock: nothing under /google answers a stranger", () => {
	it.each(["/google/connect", "/google/callback?code=x&state=y", "/google/other", "/google"])("GET %s without the page cookie → 401, the lock screen, no redirect", async (path) => {
		const res = await send(get(path));
		expect(res.status).toBe(401);
		expect(res.headers.get("Location")).toBeNull();
		expect(await res.text()).toContain('action="/unlock"');
		expect(g.calls).toHaveLength(0);
	});

	it("a forged or expired page cookie is a stranger too", async () => {
		expect((await send(get("/google/connect", "ledger_sid=v1.99999999999999.deadbeef"))).status).toBe(401);
		const old = await signedIn(new Date("2026-01-01T00:00:00Z"));
		expect((await send(get("/google/connect", old))).status).toBe(401);
	});

	it("only GET; an unknown /google address is a 404 once signed in", async () => {
		const post = new Request(BASE + "/google/connect", { method: "POST", headers: { Cookie: cookie } });
		expect((await send(post)).status).toBe(405);
		expect((await send(get("/google/other", cookie))).status).toBe(404);
	});
});

describe("GET /google/connect", () => {
	it("sends the owner to Google asking for gmail.readonly only, offline, PKCE S256, with a signed state", async () => {
		const { res, google, state, jar } = await startConnect();
		expect(res.status).toBe(302);
		expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		const q = google.searchParams;
		expect(q.get("scope")).toBe(GMAIL_SCOPE);
		expect(q.get("access_type")).toBe("offline");
		expect(q.get("prompt")?.split(" ")).toContain("consent");
		expect(q.get("include_granted_scopes")).toBe("false");
		expect(q.get("response_type")).toBe("code");
		expect(q.get("client_id")).toBe(CLIENT.GMAIL_CLIENT_ID);
		expect(q.get("redirect_uri")).toBe(`${BASE}/google/callback`);
		expect(q.get("code_challenge_method")).toBe("S256");
		expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(state).toMatch(/\.[0-9a-f]{64}$/);
		const set = res.headers.get("Set-Cookie")!;
		expect(set).toContain("HttpOnly");
		expect(set).toContain("Secure");
		expect(set).toContain("SameSite=Lax");
		expect(set).toContain("Path=/google/");
		expect(jar).not.toBe("");
		// the verifier stays in the cookie, never in Google's address
		expect(google.toString()).not.toContain(jar.split(".")[0]!);
		expect(g.calls).toHaveLength(0);
	});

	it("says 'not set up yet' (503) when the Google client is not set", async () => {
		const res = await send(get("/google/connect", cookie), makeEnv(db));
		expect(res.status).toBe(503);
		expect(await res.text()).toContain("GMAIL_CLIENT_ID");
	});
});

describe("GET /google/callback", () => {
	it("connects: trades the code with the verifier, shows the mailbox, stores the token encrypted, clears the alarm", async () => {
		db.raw.prepare("INSERT INTO alarms (key, message, raised_at) VALUES ('google_signin', 'Google refused', 'x')").run();
		const { google, state, jar } = await startConnect();
		const res = await send(callback({ code: "4/made-up-code", state, scope: GMAIL_SCOPE }, jar));
		const page = await everything(res);
		expect(res.status).toBe(200);
		expect(page).toContain(`Connected: <b>${MAILBOX}</b>`);
		// the PKCE cookie is spent
		expect(res.headers.get("Set-Cookie")).toMatch(/ledger_goog=; Path=\/google\/; Max-Age=0/);

		const exchange = new URLSearchParams(g.calls[0]!.body);
		expect(g.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
		expect(exchange.get("grant_type")).toBe("authorization_code");
		expect(exchange.get("code")).toBe("4/made-up-code");
		expect(exchange.get("redirect_uri")).toBe(`${BASE}/google/callback`);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.get("code_verifier")!)));
		expect(btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")).toBe(google.searchParams.get("code_challenge"));
		expect(g.calls[1]).toMatchObject({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile", auth: `Bearer ${ACCESS}` });

		const stored = link()!.value;
		expect(stored).not.toContain(REFRESH);
		expect(stored).not.toContain("REFRESH");
		const row = JSON.parse(stored);
		expect(row).toMatchObject({ v: 1, email: MAILBOX, connected_at: "2026-10-09T02:00:00.000Z" });
		expect(await openToken(SESSION_SECRET, row.token, MAILBOX)).toBe(REFRESH);
		// a different secret, or the row's address changed, cannot open it
		expect(await openToken("another-session-secret-made-up-0123456789", row.token, MAILBOX)).toBeNull();
		expect(await openToken(SESSION_SECRET, row.token, "someone.else@example.com")).toBeNull();
		expect(db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL").all()).toEqual([]);

		// the page's status names the mailbox — and never carries the token
		const status = await send(get("/api/status", cookie));
		const body = await status.text();
		expect(JSON.parse(body).gmail).toEqual({ ready: true, via: "page", email: MAILBOX, connected_at: "2026-10-09T02:00:00.000Z" });
		expect(body).not.toContain(REFRESH);
		expect(body).not.toContain(row.token);

		expect(page).not.toContain(REFRESH);
		expect(page).not.toContain(ACCESS);
		expect(logs.join("\n")).not.toContain("REFRESH");
	});

	it("reconnecting replaces the stored connection (a new mailbox, a new token)", async () => {
		const first = await startConnect();
		await send(callback({ code: "c1", state: first.state }, first.jar));
		g.token = () => Response.json({ access_token: ACCESS, refresh_token: "1//second-made-up-REFRESH", scope: `${GMAIL_SCOPE}` });
		g.profile = () => Response.json({ emailAddress: "bank.mailbox@example.com" });
		const again = await startConnect();
		expect((await send(callback({ code: "c2", state: again.state }, again.jar))).status).toBe(200);
		const row = JSON.parse(link()!.value);
		expect(row.email).toBe("bank.mailbox@example.com");
		expect(await openToken(SESSION_SECRET, row.token, row.email)).toBe("1//second-made-up-REFRESH");
	});

	describe("a bad or expired state is refused before Google is asked anything", () => {
		it("expired (more than 10 minutes)", async () => {
			const { state, jar } = await startConnect();
			deps.advance(STATE_TTL_MS + 1);
			const res = await send(callback({ code: "c", state }, jar));
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("expired");
		});
		it("tampered", async () => {
			const { state, jar } = await startConnect();
			const [body, sig] = state.split(".");
			const forged = JSON.parse(atob(body!.replaceAll("-", "+").replaceAll("_", "/")));
			forged.e += 3_600_000;
			const forgedBody = btoa(JSON.stringify(forged)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
			expect((await send(callback({ code: "c", state: `${forgedBody}.${sig}` }, jar))).status).toBe(400);
			expect((await send(callback({ code: "c", state: "garbage" }, jar))).status).toBe(400);
		});
		it("missing (state or PKCE cookie)", async () => {
			const { state, jar } = await startConnect();
			expect((await send(callback({ code: "c" }, jar))).status).toBe(400);
			expect((await send(callback({ code: "c", state }, null))).status).toBe(400);
		});
		it("from another tap (the state of one, the cookie of another)", async () => {
			const one = await startConnect();
			const two = await startConnect();
			expect((await send(callback({ code: "c", state: one.state }, two.jar))).status).toBe(400);
		});
		it("from another browser's session", async () => {
			const { state, jar } = await startConnect();
			const other = await signedIn(new Date("2026-10-09T01:00:00.000Z"));
			expect((await send(callback({ code: "c", state }, jar, other))).status).toBe(400);
		});
		it("signed with another secret", async () => {
			const { state, jar } = await startConnect();
			const rotated = makeEnv(db, { ...CLIENT, LEDGER_SESSION_SECRET: "rotated-session-secret-made-up-000111222333" });
			const c = await signedIn(undefined, "rotated-session-secret-made-up-000111222333");
			expect((await send(callback({ code: "c", state }, jar, c), rotated)).status).toBe(400);
		});
		afterEach(() => {
			expect(g.calls).toHaveLength(0);
			expect(link()).toBeUndefined();
		});
	});

	it("The owner pressing Cancel on Google's screen changes nothing", async () => {
		const { state, jar } = await startConnect();
		const res = await send(callback({ error: "access_denied", state }, jar));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("did not allow");
		expect(g.calls).toHaveLength(0);
		expect(link()).toBeUndefined();
	});

	it("refuses a grant without Gmail read access (the box left unticked), and keeps nothing", async () => {
		g.token = () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, scope: "openid https://www.googleapis.com/auth/userinfo.email" });
		const { state, jar } = await startConnect();
		const res = await send(callback({ code: "c", state }, jar));
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).toContain("permission to read your Gmail");
		expect(text).not.toContain(REFRESH);
		expect(link()).toBeUndefined();
		expect(g.calls).toHaveLength(1); // no profile call with a token that cannot read Gmail
	});

	it("refuses an answer with no refresh token, or Google refusing the code", async () => {
		g.token = () => Response.json({ access_token: ACCESS, scope: GMAIL_SCOPE });
		let s = await startConnect();
		expect((await send(callback({ code: "c", state: s.state }, s.jar))).status).toBe(400);
		g.token = () => Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 });
		s = await startConnect();
		const res = await send(callback({ code: "c", state: s.state }, s.jar));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("invalid_grant");
		expect(link()).toBeUndefined();
	});

	it("saves nothing when Gmail will not say which mailbox it is", async () => {
		g.profile = () => new Response("{}", { status: 403 });
		const { state, jar } = await startConnect();
		const res = await send(callback({ code: "c", state }, jar));
		expect(res.status).toBe(502);
		expect(await res.text()).not.toContain(REFRESH);
		expect(link()).toBeUndefined();
	});
});

describe("the reader's token: saved first, GMAIL_REFRESH_TOKEN as the fallback", () => {
	const refreshUsed = () => g.calls.filter((c) => new URLSearchParams(c.body).get("grant_type") === "refresh_token").map((c) => new URLSearchParams(c.body).get("refresh_token"));
	const saved = async (token: string, secret = SESSION_SECRET) => JSON.stringify({ v: 1, email: MAILBOX, token: await sealToken(secret, token, MAILBOX), connected_at: "x" });

	it("uses the token saved by 「連接 Gmail」, even when the old secret is also set", async () => {
		const gm = await gmailFromLink(makeEnv(db, { ...CLIENT, GMAIL_REFRESH_TOKEN: "1//old-env-token" }), deps, await saved(REFRESH));
		await gm!.list("x");
		expect(refreshUsed()).toEqual([REFRESH]);
	});

	it("falls back to GMAIL_REFRESH_TOKEN when nothing is saved", async () => {
		const gm = await gmailFromLink(makeEnv(db, { ...CLIENT, GMAIL_REFRESH_TOKEN: "1//old-env-token" }), deps, undefined);
		await gm!.list("x");
		expect(refreshUsed()).toEqual(["1//old-env-token"]);
	});

	it("falls back to GMAIL_REFRESH_TOKEN when the saved one cannot be opened (the secret was rotated)", async () => {
		const gm = await gmailFromLink(makeEnv(db, { ...CLIENT, GMAIL_REFRESH_TOKEN: "1//old-env-token" }), deps, await saved(REFRESH, "an-older-session-secret-made-up-0123456789"));
		await gm!.list("x");
		expect(refreshUsed()).toEqual(["1//old-env-token"]);
	});

	it("an unopenable saved token and no fallback is the sign-in alarm, not silence", async () => {
		const gm = await gmailFromLink(makeEnv(db, CLIENT), deps, await saved(REFRESH, "an-older-session-secret-made-up-0123456789"));
		await expect(gm!.list("x")).rejects.toMatchObject({ kind: "signin_failed" });
		expect(g.calls).toHaveLength(0);
	});

	it("no Google client, or no token at all: no reader (Gmail work waits, as before)", async () => {
		expect(await gmailFromLink(makeEnv(db, { GMAIL_REFRESH_TOKEN: "1//x" }), deps, await saved(REFRESH))).toBeNull();
		expect(await gmailFromLink(makeEnv(db, CLIENT), deps, undefined)).toBeNull();
	});
});

describe("the tick with the live services", () => {
	beforeEach(() => {
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'daily', 'x'), ('backfill', ?, 'x')").run(JSON.stringify({ done: true, started_at: "2026-10-01T00:00:00.000Z" }));
	});

	it("reads Gmail with the connected token", async () => {
		const { state, jar } = await startConnect();
		await send(callback({ code: "c", state }, jar));
		g.calls.length = 0;
		const r = await runTick(env, deps, liveServices(env, deps), [dailyPull]);
		expect(r.errors).toEqual([]);
		expect(new URLSearchParams(g.calls[0]!.body).get("refresh_token")).toBe(REFRESH);
		expect(g.calls.some((c) => c.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages"))).toBe(true);
	});

	it("invalid_grant raises the Google sign-in alarm, pointing at 「重新連接 Gmail」 and /google/connect; reconnecting clears it", async () => {
		let s = await startConnect();
		await send(callback({ code: "c", state: s.state }, s.jar));
		g.refresh = () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
		await runTick(env, deps, liveServices(env, deps), [dailyPull]);
		const alarm = db.raw.prepare("SELECT key, message FROM alarms WHERE cleared_at IS NULL").all() as { key: string; message: string }[];
		expect(alarm.map((a) => a.key)).toEqual(["google_signin"]);
		expect(alarm[0]!.message).toContain("/google/connect");
		expect(alarm[0]!.message).toContain("重新連接 Gmail");
		expect(alarm[0]!.message).not.toContain("REFRESH");
		// one tap later
		s = await startConnect();
		expect((await send(callback({ code: "c2", state: s.state }, s.jar))).status).toBe(200);
		expect(db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL").all()).toEqual([]);
		expect(logs.join("\n")).not.toContain("REFRESH");
	});

	it("never mutates the caller's services object", async () => {
		const svc = liveServices(env, deps);
		await runTick(makeEnv(db, { ...CLIENT, GMAIL_REFRESH_TOKEN: "1//env" }), deps, svc, [dailyPull]);
		expect(svc.gmail).toBeNull();
	});
});
