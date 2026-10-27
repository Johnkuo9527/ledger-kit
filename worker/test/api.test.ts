/// The page's API through the worker's real front door (app.ts): the lock on
/// every route, the §5.1 envelope on every answer, and each route doing what
/// the meeting-points contract says. Made-up data only (helpers/harness.ts).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { API_ROUTES } from "../src/api";
import { handleRequest, type App } from "../src/app";
import type { LedgerEnv } from "../src/env";
import { BASE, CTX, get, json, makeDeps, makeEnv, NOW, post, seedWorld, signedIn, TEST_ASSETS, withLikeCap, type World } from "./helpers/harness";

let raw: TestDb;
let env: LedgerEnv;
let app: App & { deps: ReturnType<typeof makeDeps> };
let world: World;
let cookie: string;

beforeEach(async () => {
	raw = freshDb();
	world = await seedWorld(raw);
	env = makeEnv(withLikeCap(raw));
	app = { assets: TEST_ASSETS, deps: makeDeps() };
	cookie = await signedIn();
});
afterEach(() => raw.close());

const send = (r: Request, e: LedgerEnv = env) => handleRequest(r, e, CTX, app);

/// Concrete addresses for a route pattern: each `([^/]+)` becomes an id, and
/// each `(a|b|c)` becomes one address per choice.
function concreteAll(pattern: RegExp): string[] {
	const base = pattern.source.replace(/^\^/, "").replace(/\$$/, "").replaceAll("\\/", "/").replace("([^/]+)", "trip-p");
	const alt = /\(([a-z|-]+)\)/.exec(base);
	return alt ? alt[1]!.split("|").map((a) => base.replace(alt[0], a)) : [base];
}
const concrete = (pattern: RegExp) => concreteAll(pattern)[0]!;
const EVERY_ROUTE = API_ROUTES.flatMap((r) => concreteAll(r.pattern).map((path) => [r.method, path] as const));

/// The routes CONTRACT.md §5 names. Each must be served.
const CONTRACT_ROUTES: [string, string][] = [
	["GET", "/api/overview"],
	["GET", "/api/lines"],
	["GET", "/api/months"],
	["GET", "/api/trips"],
	["GET", "/api/subscriptions"],
	["GET", "/api/needs-ok"],
	["POST", "/api/trips/t1/confirm"],
	["POST", "/api/trips/t1/reject"],
	["POST", "/api/lines/l1/reimbursable"],
	["POST", "/api/reimbursable-ranges"],
	["POST", "/api/cash"],
	// round 2 (meeting points A, C, D)
	["GET", "/api/payments"],
	["POST", "/api/accounts/a1/settings"],
	["POST", "/api/lines/l1/review"],
	["POST", "/api/needs-ok/held/e1/dismiss"],
	["POST", "/api/months/s1/reviewed"],
	["POST", "/api/months/s1/recheck"],
	["POST", "/api/needs-ok/pdf/taishin/retry"],
	// : statement PDFs the owner uploads (Citi)
	["POST", "/api/statements/upload"],
	["GET", "/api/statements/uploads"],
	["POST", "/api/statements/uploads/u1/account"],
	["POST", "/api/statements/uploads/u1/dismiss"],
	// (14 Oct 2026): the owner's word on a bill
	["POST", "/api/payments/s1/paid"],
	["POST", "/api/payments/s1/seen"],
	// (19 Oct 2026): prepaid cards — a top-up's bonus, a shop's SMS
	["POST", "/api/wallet-topups/l1/credit"],
	["POST", "/api/wallet-sms/s1/accept"],
	["POST", "/api/wallet-sms/s1/checked"],
	["POST", "/api/wallet-sms/s1/dismiss"],
];

describe("no route answers without the page's cookie", () => {
	it.each(EVERY_ROUTE)("%s %s → 401, the envelope, and nothing else", async (method, path) => {
		const r = method === "GET" ? get(path) : post(path, {});
		const res = await send(r);
		expect(res.status).toBe(401);
		expect(await json(res)).toEqual({ ok: false, message: "not signed in" });
	});

	it("the sweep covers every route the contract names (it reads the router, so it cannot go stale)", () => {
		for (const [method, path] of CONTRACT_ROUTES) {
			expect([method, path, API_ROUTES.some((r) => r.method === method && r.pattern.test(path))]).toEqual([method, path, true]);
		}
		expect(EVERY_ROUTE.length).toBe(45); // + 1 GET /api/wallets (19 Oct: each prepaid wallet's balance, lots and uses); + 4 prepaid cards (19 Oct: wallet-topups/:id/credit, wallet-sms/:id/accept|checked|dismiss); + 2 bills (14 Oct: payments/:id/paid, /seen); + 4 statement uploads (upload, uploads, :id/account, :id/dismiss); 24 addresses (+ POST /api/categories, /api/lines/:id/offset, /kind, /subscription); the trip one has 4 verbs; round 2 part C: + 7 (payments, settings, review, held dismiss, months reviewed|recheck, pdf retry)
	});

	it("an address that does not exist is a 401 too, so a stranger cannot map the API", async () => {
		expect((await send(get("/api/no-such-thing"))).status).toBe(401);
		expect((await send(get("/api"))).status).toBe(401);
	});

	it("refuses a forged cookie, one signed with another secret, and an expired one", async () => {
		for (const bad of ["ledger_sid=v1.99999999999999.deadbeef", await signedIn(new Date(NOW), "another-secret-that-is-long-enough-0123456789"), "ledger_sid=", "other=1"]) {
			expect((await send(get("/api/overview", bad))).status).toBe(401);
		}
		const old = await signedIn(new Date("2026-01-01T00:00:00Z")); // 90 days ran out in April
		expect((await send(get("/api/overview", old))).status).toBe(401);
	});

	it("is locked when the session secret is missing or too short — never open", async () => {
		expect((await send(get("/api/overview", cookie), makeEnv(raw, { LEDGER_SESSION_SECRET: undefined }))).status).toBe(401);
		expect((await send(get("/api/overview", cookie), makeEnv(raw, { LEDGER_SESSION_SECRET: "short" }))).status).toBe(401);
	});

	it("the Apple Pay key and the connector's token do not open the page's API", async () => {
		const tapKey = { Authorization: `Bearer ${env.LEDGER_SHORTCUT_KEY}` };
		expect((await send(get("/api/overview", undefined, tapKey))).status).toBe(401);
	});
});

describe("every read says ok: true (the page draws anything else as 'couldn't load')", () => {
	it.each(API_ROUTES.filter((r) => r.method === "GET").map((r) => concrete(r.pattern)))("%s", async (path) => {
		const res = await send(get(path, cookie));
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("application/json");
		expect(res.headers.get("Cache-Control")).toContain("no-store");
		expect((await json(res)).ok).toBe(true);
	});
});

describe("the reads", () => {
	it("overview: October's totals, categories, accounts, reimbursable, coverage", async () => {
		// Spending: 4.50 + 30.00 + 12.00 + 42.00 (台新 at the reference rate) = 88.50, 4 lines; 42.00 is an estimate.
		const b = await json(await send(get("/api/overview?month=2026-10", cookie)));
		expect(b).toMatchObject({ ok: true, month: "2026-10", from: "2026-10-01", to: "2026-10-31" });
		expect(b.totals).toMatchObject({ spending_home: { minor: 8850, display: "SGD 88.50" }, count: 4, unconfirmed_home: { minor: 4200 } });
		expect(b.reimbursable_home).toMatchObject({ minor: 0 });
		const coverage = b.coverage as { account_id: string; partial: boolean; message: string }[];
		expect(coverage.find((c) => c.account_id === "card-t")).toMatchObject({ partial: true });
	});

	it("overview defaults to this month in Singapore", async () => {
		expect(await json(await send(get("/api/overview", cookie)))).toMatchObject({ month: "2026-10" });
	});

	it("lines: newest first, paged, with the WHOLE filter's totals on every page", async () => {
		const first = await json(await send(get("/api/lines?from=2026-10-01&to=2026-10-31&limit=2", cookie)));
		const lines = first.lines as { id: string; date: string }[];
		expect(lines.map((l) => l.id)).toEqual(["twd-1", world.cash]);
		expect(first.totals).toMatchObject({ spending_home: { minor: 8850 }, count: 4 });
		const second = await json(await send(get(`/api/lines?from=2026-10-01&to=2026-10-31&limit=2&cursor=${first.next_cursor}`, cookie)));
		expect((second.lines as { id: string }[]).map((l) => l.id)).toEqual([world.book, world.kopi]);
		expect(second.next_cursor).toBeNull();
		expect(second.totals).toEqual(first.totals);
	});

	it("lines: filters by account (id or name), search text, trip, reimbursable, flags", async () => {
		const ids = async (q: string) => ((await json(await send(get(`/api/lines?${q}`, cookie)))).lines as { id: string }[]).map((l) => l.id).sort();
		expect(await ids("account=card-a")).toEqual([world.book, world.kopi, "sub-3"].sort());
		expect(await ids("account=card-t")).toEqual(["twd-1"]);
		expect(await ids("q=kopi")).toEqual([world.kopi]);
		expect(await ids("trip=trip-p")).toEqual(["booking-1"]);
		expect(await ids("reimbursable=true")).toEqual([]);
		expect(await ids("provisional=false&from=2026-10-01")).toEqual([world.cash]);
		expect(await ids("category=Uncategorised&from=2026-10-04&to=2026-10-04")).toEqual([world.cash]);
	});

	it("lines: a long Chinese search stays under D1's 50-byte LIKE cap (the harness enforces it)", async () => {
		const res = await send(get(`/api/lines?q=${encodeURIComponent("台新銀行信用卡消費全聯福利中心台北市中正區分店")}`, cookie));
		expect(res.status).toBe(200);
	});

	it("months, trips, subscriptions, needs-ok, accounts, ranges", async () => {
		expect(((await json(await send(get("/api/months", cookie)))).months as { statement_id: string }[]).map((m) => m.statement_id)).toEqual(["st-bad"]);
		expect(((await json(await send(get("/api/months?account=card-b", cookie)))).months as unknown[]).length).toBe(0);
		const trips = (await json(await send(get("/api/trips", cookie)))).trips as { id: string; status: string; total_home: { minor: number } }[];
		expect(trips.map((t) => [t.id, t.status])).toEqual([
			["trip-p", "proposed"],
			["trip-c", "confirmed"],
		]);
		expect(trips[0]!.total_home.minor).toBe(50000);
		const subs = await json(await send(get("/api/subscriptions", cookie)));
		expect(subs).toMatchObject({ monthly_total_home: { minor: 1599 }, monthly_total_missing: 0 });
		const needs = await json(await send(get("/api/needs-ok", cookie)));
		expect(needs).toMatchObject({ count: 3, other_held: 0 });
		expect((needs.held_taps as { card: string }[])[0]!.card).toBe("MYSTERY CARD");
		const accounts = (await json(await send(get("/api/accounts", cookie)))).accounts as { id: string; wallet_names: string[] }[];
		expect(accounts.find((a) => a.id === "card-a")!.wallet_names).toEqual(["TEST REWARDS"]);
		expect(await json(await send(get("/api/reimbursable-ranges", cookie)))).toEqual({ ok: true, ranges: [] });
	});
});

describe("the writes", () => {
	it("confirm a trip, with corrected dates; then it is no longer waiting on the owner", async () => {
		const b = await json(await send(post("/api/trips/trip-p/confirm", { end_date: "2026-09-15" }, cookie)));
		expect(b.trip).toMatchObject({ id: "trip-p", status: "confirmed", end_date: "2026-09-15" });
		expect((b.lines as { id: string }[]).map((l) => l.id)).toEqual(["booking-1"]);
		expect((await json(await send(get("/api/needs-ok", cookie)))).count).toBe(2);
	});

	it("reject (dismiss), restore and edit a trip", async () => {
		expect((await json(await send(post("/api/trips/trip-p/reject", {}, cookie)))).trip).toMatchObject({ status: "dismissed" });
		expect((await json(await send(post("/api/trips/trip-p/restore", {}, cookie)))).trip).toMatchObject({ status: "proposed" });
		expect((await json(await send(post("/api/trips/trip-p/edit", { name: "Testville" }, cookie)))).trip).toMatchObject({ name: "Testville", status: "proposed" });
	});

	it("a confirmed trip cannot be rejected: 400 with the reason, and nothing changes", async () => {
		const res = await send(post("/api/trips/trip-c/reject", {}, cookie));
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({ ok: false, message: "a confirmed trip cannot be dismissed" });
	});

	it("mark one line reimbursable, then clear the choice", async () => {
		const on = await json(await send(post(`/api/lines/${world.kopi}/reimbursable`, { value: true }, cookie)));
		expect(on.line).toMatchObject({ id: world.kopi, reimbursable: { effective: true, source: "override" } });
		const off = await json(await send(post(`/api/lines/${world.kopi}/reimbursable`, { value: null }, cookie)));
		expect(off.line).toMatchObject({ reimbursable: { effective: false, source: null } });
		const bad = await send(post(`/api/lines/${world.kopi}/reimbursable`, { value: "yes" }, cookie));
		expect(bad.status).toBe(400);
		expect((await send(post("/api/lines/nope/reimbursable", { value: true }, cookie))).status).toBe(400);
	});

	it("a reimbursable range covers its lines; the same dates twice are one range; it can be deleted", async () => {
		// 10-02 … 10-03: Kopi Corner and Bookshop.
		const b = await json(await send(post("/api/reimbursable-ranges", { from: "2026-10-02", to: "2026-10-03", note: "client visit" }, cookie)));
		expect(b).toMatchObject({ ok: true, range: { start_date: "2026-10-02", end_date: "2026-10-03", note: "client visit" }, count: 2, affected_lines: 2 });
		const again = await json(await send(post("/api/reimbursable-ranges", { from: "2026-10-02", to: "2026-10-03" }, cookie)));
		expect(again).toMatchObject({ count: 2, affected_lines: 0 });
		expect(((await json(await send(get("/api/reimbursable-ranges", cookie)))).ranges as unknown[]).length).toBe(1);
		const id = (b.range as { id: string }).id;
		expect(await json(await send(post(`/api/reimbursable-ranges/${id}/delete`, {}, cookie)))).toEqual({ ok: true, ranges: [], affected_lines: 2 });
		expect((await send(post("/api/reimbursable-ranges", { from: "2026-10-05", to: "2026-10-01" }, cookie))).status).toBe(400);
	});

	it("add cash (201, the new line), never in the future, never zero", async () => {
		const res = await send(post("/api/cash", { date: "2026-10-08", amount: "1,200", currency: "JPY", merchant: "Ramen", note: "lunch" }, cookie));
		expect(res.status).toBe(201);
		const b = await json(res);
		expect(b.line).toMatchObject({ account: { id: "cash" }, amount: { original: { currency: "JPY", minor: 1200 } }, evidence: ["manual"], note: "lunch" });
		expect((await send(post("/api/cash", { date: "2026-10-10", amount: "5", merchant: "x" }, cookie))).status).toBe(400);
		expect((await send(post("/api/cash", { amount: "0", merchant: "x" }, cookie))).status).toBe(400);
		expect(await json(await send(post("/api/cash", { amount: "1.234", merchant: "x" }, cookie)))).toEqual({ ok: false, message: 'amount "1.234" is not an amount in SGD like 12.50' });
	});

	it("correct the SGD figure of a 台新 line — and refuse a card estimate", async () => {
		const b = await json(await send(post("/api/lines/twd-1/home", { home_amount: "41.10" }, cookie)));
		expect(b.line).toMatchObject({ amount: { home: { minor: 4110, status: "confirmed", set_by: "owner" } } });
		const card = await send(post(`/api/lines/${world.kopi}/home`, { home_amount: "4.00" }, cookie));
		expect(card.status).toBe(400);
	});

	it("The owner's word on a subscription", async () => {
		const b = await json(await send(post("/api/subscriptions/sub-s", { action: "cancelled" }, cookie)));
		expect((b.subscriptions as { id: string; status: string }[])[0]).toMatchObject({ id: "sub-s", status: "cancelled" });
		expect(b.monthly_total_home).toMatchObject({ minor: 0 });
		expect((await send(post("/api/subscriptions/nope", { action: "ignore" }, cookie))).status).toBe(404);
	});

	it("naming a held tap's Wallet card records the tap on that card", async () => {
		const b = await json(await send(post("/api/wallet-names", { name: "Mystery Card", account_id: "card-b" }, cookie)));
		expect(b).toEqual({ ok: true, wallet_key: "MYSTERY CARD", account_id: "card-b", recorded: 1, still_held: 0 });
		expect((await json(await send(get("/api/needs-ok", cookie)))).held_taps).toEqual([]);
		expect((await send(post("/api/wallet-names", { name: "Mystery Card", account_id: "card-a" }, cookie))).status).toBe(400);
	});
});

describe("the envelope holds on every failure", () => {
	it("400 for a bad month, a bad date, a bad flag, a bad cursor", async () => {
		for (const path of ["/api/overview?month=2026-13", "/api/lines?from=yesterday", "/api/lines?flags=lost", "/api/lines?cursor=zzz", "/api/lines?limit=9999"]) {
			const res = await send(get(path, cookie));
			expect([path, res.status]).toEqual([path, 400]);
			const b = await json(res);
			expect(b.ok).toBe(false);
			expect(typeof b.message).toBe("string");
		}
	});

	it("404 for an unknown trip or address, 405 for the wrong method", async () => {
		expect(await json(await send(post("/api/trips/nope/confirm", {}, cookie)))).toEqual({ ok: false, message: "no such trip" });
		expect((await send(get("/api/lines?trip=nope", cookie))).status).toBe(404);
		expect((await send(get("/api/nothing-here", cookie))).status).toBe(404);
		const wrong = await send(get("/api/cash", cookie));
		expect(wrong.status).toBe(405);
		expect((await json(wrong)).ok).toBe(false);
	});

	it("400 for a body that is not a JSON object; 413 for a huge one", async () => {
		expect((await send(post("/api/cash", "{not json", cookie))).status).toBe(400);
		expect((await send(post("/api/cash", "[1,2]", cookie))).status).toBe(400);
		expect((await send(post("/api/cash", { merchant: "x".repeat(70_000) }, cookie))).status).toBe(413);
	});

	it("500 when the database fails — ok:false, a plain message, no internals", async () => {
		const broken = makeEnv({
			prepare() {
				throw new Error("D1_ERROR: no such table: secret_internals");
			},
			batch: async () => [],
		});
		for (const path of ["/api/overview", "/api/lines", "/api/trips"]) {
			const res = await send(get(path, cookie), broken);
			expect(res.status).toBe(500);
			const b = await json(res);
			expect(b).toEqual({ ok: false, message: "the ledger could not answer just now" });
		}
	});
});

describe("another site cannot make the owner's browser change his ledger", () => {
	it("a write from another origin, or a cross-site fetch, is refused even with the cookie", async () => {
		const evil = await send(post("/api/cash", { amount: "5", merchant: "x" }, cookie, { Origin: "https://evil.example" }));
		expect(evil.status).toBe(403);
		const cross = await send(post("/api/cash", { amount: "5", merchant: "x" }, cookie, { "Sec-Fetch-Site": "cross-site" }));
		expect(cross.status).toBe(403);
		expect((await json(await send(get("/api/lines?from=2026-10-08", cookie)))).lines).toEqual([]);
		const same = await send(post("/api/cash", { amount: "5", merchant: "x" }, cookie, { Origin: BASE, "Sec-Fetch-Site": "same-origin" }));
		expect(same.status).toBe(201);
	});
});

describe("Design's fixtures and these routes agree on every field (contract test)", () => {
	const FIXTURES = fileURLToPath(new URL("../../page/fixtures/", import.meta.url));

	/// Every key the fixture has, the response has too, with the same JSON type,
	/// all the way down (an array is checked through its first element).
	function shapeGaps(fixture: unknown, actual: unknown, path = "$"): string[] {
		if (fixture === null || actual === null) return [];
		if (Array.isArray(fixture)) {
			if (!Array.isArray(actual)) return [`${path}: expected an array`];
			return fixture.length && actual.length ? shapeGaps(fixture[0], actual[0], `${path}[0]`) : [];
		}
		if (typeof fixture === "object") {
			if (typeof actual !== "object" || Array.isArray(actual)) return [`${path}: expected an object`];
			return Object.keys(fixture as object).flatMap((k) =>
				k in (actual as object) ? shapeGaps((fixture as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], `${path}.${k}`) : [`${path}.${k}: missing`],
			);
		}
		return typeof fixture === typeof actual ? [] : [`${path}: ${typeof actual}, fixture has ${typeof fixture}`];
	}

	const CASES: [string, () => Promise<Response>][] = [
		["overview.json", () => send(get("/api/overview?month=2026-10", cookie))],
		["lines.json", () => send(get("/api/lines", cookie))],
		["months.json", () => send(get("/api/months", cookie))],
		["trips.json", () => send(get("/api/trips", cookie))],
		["subscriptions.json", () => send(get("/api/subscriptions", cookie))],
		["needs-ok.json", () => send(get("/api/needs-ok", cookie))],
		["accounts.json", () => send(get("/api/accounts", cookie))],
		["trip-confirm.json", () => send(post("/api/trips/trip-p/confirm", {}, cookie))],
		["trip-reject.json", () => send(post("/api/trips/trip-p/reject", {}, cookie))],
		["line-reimbursable.json", () => send(post(`/api/lines/${world.kopi}/reimbursable`, { value: true }, cookie))],
		["cash.json", () => send(post("/api/cash", { amount: "4.50", merchant: "Kopi" }, cookie))],
		["reimbursable-ranges-post.json", () => send(post("/api/reimbursable-ranges", { from: "2026-10-02", to: "2026-10-03", note: "x" }, cookie))],
		["subscription-action.json", () => send(post("/api/subscriptions/sub-s", { action: "ignore" }, cookie))],
		["wallet-names.json", () => send(post("/api/wallet-names", { name: "Mystery Card", account_id: "card-b" }, cookie))],
	];

	it.each(CASES)("%s", async (file, call) => {
		if (!existsSync(FIXTURES + file)) return; // Design has not written it (yet); nothing to hold us to
		const fixture = JSON.parse(readFileSync(FIXTURES + file, "utf8"));
		const res = await call();
		expect(res.ok).toBe(true);
		expect(shapeGaps(fixture, await res.json())).toEqual([]);
	});

	it("reimbursable-ranges.json and range-delete.json (need a range first)", async () => {
		const created = await json(await send(post("/api/reimbursable-ranges", { from: "2026-10-02", to: "2026-10-03", note: "x" }, cookie)));
		const id = (created.range as { id: string }).id;
		for (const [file, call] of [
			["reimbursable-ranges.json", () => send(get("/api/reimbursable-ranges", cookie))],
			["range-delete.json", () => send(post(`/api/reimbursable-ranges/${id}/delete`, {}, cookie))],
		] as const) {
			if (!existsSync(FIXTURES + file)) continue;
			const fixture = JSON.parse(readFileSync(FIXTURES + file, "utf8"));
			const res = await call();
			// range-delete's fixture lists one range left; ours has none left, so compare the envelope keys.
			const actual = (await res.json()) as Record<string, unknown>;
			expect([file, Object.keys(fixture).filter((k) => !(k in actual))]).toEqual([file, []]);
		}
	});
});
