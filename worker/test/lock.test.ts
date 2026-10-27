/// The page's lock. THE ASSERTION THIS FILE EXISTS FOR is "a stranger gets
/// nothing": not the page, not a script, not one figure.

import { homeMeta } from "../src/page";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { handleRequest, type App } from "../src/app";
import type { LedgerEnv } from "../src/env";
import { checkSession, mintCookie, openValue, sealValue } from "../src/session";
import { CTX, get, makeDeps, makeEnv, NOW, PAGE_TELL, seedWorld, SESSION_SECRET, signedIn, TEST_ASSETS, UNLOCK_KEY } from "./helpers/harness";

let db: TestDb;
let env: LedgerEnv;
let app: App & { deps: ReturnType<typeof makeDeps> };
beforeEach(async () => {
	db = freshDb();
	await seedWorld(db);
	env = makeEnv(db);
	app = { assets: TEST_ASSETS, deps: makeDeps() };
});
afterEach(() => db.close());

const send = (r: Request, e: LedgerEnv = env) => handleRequest(r, e, CTX, app);
const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
	new Request("https://ledger.test.workers.dev" + path, { method: "POST", body: new URLSearchParams(fields), headers });

describe("a stranger", () => {
	it.each(["/", "/index.html", "/app.js", "/icon.png", "/no-such-page", "/favicon.ico"])("gets the lock screen at %s: 401, and not one byte of the page", async (path) => {
		const res = await send(get(path));
		expect(res.status).toBe(401);
		const body = await res.text();
		expect(body).not.toContain(PAGE_TELL);
		expect(body).not.toContain("page script");
		expect(body).toContain("Ledger");
		// Nothing about the owner's money on the door: no account, merchant or amount from the seeded world.
		for (const word of ["Kopi", "Hawker", "card-a", "SGD", "Streamco", "Testville"]) expect(body).not.toContain(word);
		expect(body.length).toBeLessThan(2500);
		expect(res.headers.get("Set-Cookie")).toBeNull();
		expect(res.headers.get("Cache-Control")).toContain("no-store");
	});

	it("can read the privacy policy without a key: 200, fixed text, not one byte of the ledger", async () => {
		for (const method of ["GET", "HEAD"]) {
			const res = await send(new Request("https://ledger.test.workers.dev/privacy", { method }));
			expect(res.status).toBe(200);
			expect(res.headers.get("Set-Cookie")).toBeNull();
			expect(res.headers.get("Cache-Control")).toContain("no-store");
			expect(res.headers.get("X-Frame-Options")).toBe("DENY");
			expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
			const body = await res.text();
			expect(body).toContain("Privacy policy");
			expect(body).toContain("gmail.readonly");
			expect(body).toContain("隱私權政策");
			expect(body).not.toContain(PAGE_TELL);
			expect(body).not.toContain("<script");
			expect(body).not.toContain("@"); // no email address, the owner's or anyone's
			for (const word of ["Kopi", "Hawker", "card-a", "SGD", "Streamco", "Testville", UNLOCK_KEY, SESSION_SECRET]) expect(body).not.toContain(word);
		}
	});

	it("the lock screen links to the privacy policy", async () => {
		expect(await (await send(get("/"))).text()).toContain('href="/privacy"');
	});

	it("the privacy policy opens nothing else: a POST there, or an address beside it, is still the lock", async () => {
		expect((await send(form("/privacy", {}))).status).toBe(401);
		for (const path of ["/privacy/", "/privacy.html", "/privacy/x", "/api/privacy"]) expect((await send(get(path))).status).toBe(401);
	});

	it("gets nowhere with a wrong key — after the same pause every time", async () => {
		let paused = 0;
		app.deps.sleep = async (ms) => {
			paused += ms;
		};
		for (const key of ["wrong", UNLOCK_KEY.slice(0, -1), UNLOCK_KEY + "x", ""]) {
			const res = await send(get(`/unlock?key=${encodeURIComponent(key)}`));
			expect(res.status).toBe(401);
			expect(res.headers.get("Set-Cookie")).toBeNull();
		}
		expect(paused).toBe(3 * 400); // the empty key is "paste your key", not a guess
	});

	it("cannot unlock a ledger whose key or session secret is missing or short", async () => {
		for (const over of [{ LEDGER_UNLOCK_KEY: undefined }, { LEDGER_UNLOCK_KEY: "short" }, { LEDGER_SESSION_SECRET: undefined }, { LEDGER_SESSION_SECRET: "short" }]) {
			const res = await send(get(`/unlock?key=${encodeURIComponent(UNLOCK_KEY)}`), makeEnv(db, over));
			expect(res.status).toBe(401);
			expect(res.headers.get("Set-Cookie")).toBeNull();
			expect(await res.text()).toContain("not been given its key");
		}
	});
});

describe("The owner", () => {
	it("taps his link: a 303 home that takes the key out of the address bar, and a cookie no script can read", async () => {
		const res = await send(get(`/unlock?key=${encodeURIComponent(UNLOCK_KEY)}`));
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/");
		const set = res.headers.get("Set-Cookie")!;
		expect(set).toMatch(/^ledger_sid=v1\.\d+\.[0-9a-f]{64}; Path=\/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax$/);
		const page = await send(get("/", set.split(";")[0]));
		expect(page.status).toBe(200);
		expect(await page.text()).toContain(PAGE_TELL);
	});

	it("or pastes his key into the lock screen's box", async () => {
		const res = await send(form("/unlock", { key: ` ${UNLOCK_KEY} ` }));
		expect(res.status).toBe(303);
		expect(res.headers.get("Set-Cookie")).toContain("ledger_sid=v1.");
	});

	it("gets the page and its files, with a lock on scripts, frames and caching", async () => {
		const cookie = await signedIn();
		const page = await send(get("/", cookie));
		expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		const csp = page.headers.get("Content-Security-Policy")!;
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(page.headers.get("X-Frame-Options")).toBe("DENY");
		const js = await send(get("/app.js", cookie));
		expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
		expect(await js.text()).toBe("/* page script */");
		const png = await send(get("/icon.png", cookie));
		expect(new Uint8Array(await png.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		expect((await send(get("/nope.js", cookie))).status).toBe(404);
	});

	it("is asked for his key again after 90 days, told why", async () => {
		const old = await signedIn(new Date("2026-07-01T00:00:00Z")); // ran out on 29 September
		const res = await send(get("/", old));
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("needs your key again");
	});

	it("signs out", async () => {
		const res = await send(new Request("https://ledger.test.workers.dev/signout", { method: "POST", headers: { Cookie: await signedIn() } }));
		expect(res.status).toBe(401);
		expect(res.headers.get("Set-Cookie")).toBe("ledger_sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
	});

	it("rotating the session secret signs every browser out", async () => {
		const cookie = await signedIn();
		const rotated = makeEnv(db, { LEDGER_SESSION_SECRET: "a-brand-new-secret-after-a-lost-phone-0123456789" });
		expect((await send(get("/", cookie), rotated)).status).toBe(401);
	});

	it("sees a plain 'not built yet' when the worker was deployed without Design's page", async () => {
		const empty = { ...app, assets: {} };
		const res = await handleRequest(get("/", await signedIn()), env, CTX, empty);
		expect(res.status).toBe(503);
	});
});

describe("the cookie and the sealed hand-off", () => {
	it("a cookie is valid until it expires, then stale; a tampered one is nothing", async () => {
		const now = new Date(NOW);
		const set = (await mintCookie(SESSION_SECRET, now)).split(";")[0]!;
		const req = (c: string) => new Request("https://x/", { headers: { Cookie: c } });
		expect(await checkSession(req(set), SESSION_SECRET, now)).toBe("valid");
		expect(await checkSession(req(set), SESSION_SECRET, new Date(now.getTime() + 91 * 86_400_000))).toBe("stale");
		const [name, value] = set.split("=");
		const [v, exp, sig] = value!.split(".");
		expect(await checkSession(req(`${name}=${v}.${Number(exp) + 86_400_000}.${sig}`), SESSION_SECRET, now)).toBe("none");
	});

	it("a sealed value opens only with its secret and its purpose, and survives Chinese text", async () => {
		const sealed = await sealValue(SESSION_SECRET, "p1", { clientName: "測試 Claude" });
		expect(await openValue(SESSION_SECRET, "p1", sealed)).toEqual({ clientName: "測試 Claude" });
		expect(await openValue(SESSION_SECRET, "p2", sealed)).toBeNull();
		expect(await openValue("another-secret-long-enough-to-count-0123456789", "p1", sealed)).toBeNull();
		const [body, sig] = sealed.split(".");
		expect(await openValue(SESSION_SECRET, "p1", `${body}x.${sig}`)).toBeNull();
	});
});

describe("Design's real page, bundled", () => {
	const GENERATED = fileURLToPath(new URL("../generated/page-assets.ts", import.meta.url));

	it("is in the bundle, without the made-up fixtures or Design's notes", async () => {
		expect(existsSync(GENERATED)).toBe(true); // `npm test` builds it first
		const { PAGE_ASSETS } = await import("../generated/page-assets");
		const paths = Object.keys(PAGE_ASSETS);
		expect(paths.some((p) => p.startsWith("fixtures/"))).toBe(false);
		expect(paths.some((p) => p.endsWith(".md"))).toBe(false);
		if (!existsSync(fileURLToPath(new URL("../../page/index.html", import.meta.url)))) return;
		expect(paths).toContain("index.html");
		// Every script and stylesheet the page names is in the bundle (CSP allows only same-origin files).
		const index = PAGE_ASSETS["index.html"]!.body;
		for (const [, src] of index.matchAll(/(?:src|href)="([^":#?]+\.(?:js|css))"/g)) expect(paths).toContain(src!.replace(/^\.?\//, ""));
		// No inline <script> (the CSP would block it) and nothing loaded from another site.
		expect(index).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
		expect(index).not.toMatch(/(?:src|href)="https?:\/\//);
		const res = await handleRequest(get("/", await signedIn()), env, CTX, { ...app, assets: PAGE_ASSETS });
		expect(res.status).toBe(200);
		// The page exactly as Design wrote it, plus the one line telling it the owner's home (page.ts homeMeta)
		// and its lang attribute set to the owner's language (the test env's: zh-Hant).
		const written = readFileSync(fileURLToPath(new URL("../../page/index.html", import.meta.url)), "utf8");
		expect(await res.text()).toBe(written.replace(/<html lang="[^"]*">/, '<html lang="zh-Hant">').replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${homeMeta()}`));
	});
});

describe("the unlock key never reaches the logs", () => {
	it("Cloudflare's invocation logs and traces (which record full addresses) are off", () => {
		const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
		const table = (name: string) => new RegExp(`^\\[${name.replace(".", "\\.")}\\]\\n([^[]*)`, "m").exec(toml)?.[1] ?? "";
		expect(table("observability.logs")).toMatch(/^invocation_logs = false$/m);
		expect(table("observability.traces")).toMatch(/^enabled = false$/m);
	});

	it("the worker's own log lines never print a request's address or query", () => {
		const dir = new URL("../src/", import.meta.url);
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
			const src = readFileSync(new URL(f, dir), "utf8");
			for (const m of src.matchAll(/console\.(?:log|info|warn|error|debug)\(([^;]*)\);/g)) expect(m[1], f).not.toMatch(/\burl\b|request|searchParams|\.search\b|headers/i);
		}
	});
});
