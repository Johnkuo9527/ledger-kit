/// Tabs took 3–5 s on the owner's phone and laptop (20 Oct 2026). Locally the
/// code answers every page read in milliseconds; what made a tab slow was the
/// NUMBER OF ROUND TRIPS a read makes to D1, one after another — live, each one is
/// a hop from the worker to the database. These tests hold two things:
///
///   1. every page read answers exactly what it answered before the speed-up
///      (byte for byte, on a made-up year of the owner's size) — no total, figure or
///      field moved;
///   2. every page read makes at most a few round trips to D1, so a tab costs a
///      few hops, not thirty.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertRow } from "../../src/db";
import { line, PREPAID, WALLET, DEMO } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { put } from "../../test/helpers/world";
import { handleRequest } from "../src/app";
import { CTX, get, makeDeps, makeEnv, post, roundTripDb, seedYear, signedIn, TEST_ASSETS, YEAR_CATEGORIES } from "./helpers/harness";

/// After the wallets started (19 Oct), so their top-ups and spending are in the year.
const AT = "2026-10-20T08:00:00.000Z";

const GOLDEN = fileURLToPath(new URL("./fixtures/page-reads.golden.json", import.meta.url));

let raw: TestDb;
let rt: ReturnType<typeof roundTripDb>;
let cookie: string;

beforeAll(async () => {
	raw = freshDb();
	await seedYear(raw);
	cookie = await signedIn(new Date(AT));
	// Three prepaid wallets with a top-up and some spending each (made-up figures).
	for (const w of [WALLET, PREPAID, DEMO]) await insertRow(raw, "accounts", w).run();
	const seedDeps = makeDeps(AT);
	const write = async (path: string, body: unknown) => {
		const res = await handleRequest(post(path, body, cookie), makeEnv(raw, { LEDGER_CATEGORIES: YEAR_CATEGORIES.join(", ") }), CTX, { assets: TEST_ASSETS, deps: seedDeps });
		if (res.status >= 300) throw new Error(`${path}: ${await res.text()}`);
	};
	await put(raw, "lines", line({ id: "yw-hg", account_id: "card-c", txn_date: "2026-10-19", created_at: "2026-10-19T04:00:00.000Z", merchant_raw: "SAMPLE BISTRO SINGAPORE", merchant_key: "SAMPLE BISTRO", merchant_name: "Sample Bistro", orig_minor: 20000, bill_minor: 20000, home_minor: 20000 }));
	await write("/api/lines/yw-hg/kind", { kind: "wallet_topup", wallet: "sample-bistro", credit: "240" });
	await put(raw, "lines", line({ id: "yw-xx", account_id: "card-a", txn_date: "2026-10-19", created_at: "2026-10-19T05:00:00.000Z", merchant_raw: "DEMO NOODLE HOUSE", merchant_key: "DEMO NOODLE HOUSE", merchant_name: "Demo Noodle", orig_minor: 30000, bill_minor: 30000, home_minor: 30000 }));
	await write("/api/lines/yw-xx/kind", { kind: "wallet_topup", wallet: "demo-noodle" });
	await write("/api/cash", { date: "2026-10-19", amount: "24.00", currency: "SGD", merchant: "Sample Bistro", account_id: "wallet-hg" });
	await write("/api/cash", { date: "2026-10-19", amount: "31.40", currency: "SGD", merchant: "Demo Noodle", account_id: "wallet-xx" });
	await write("/api/cash", { date: "2026-10-18", amount: "12.40", currency: "SGD", merchant: "Grab ride", account_id: "wallet-g" });
	rt = roundTripDb(raw);
});
afterAll(() => raw.close());

const app = () => ({ assets: TEST_ASSETS, deps: makeDeps(AT) });
const env = () => makeEnv(rt.db, { LEDGER_CATEGORIES: YEAR_CATEGORIES.join(", ") });

async function read(path: string): Promise<{ body: string; trips: number; queries: number }> {
	rt.reset();
	const res = await handleRequest(get(path, cookie), env(), CTX, app());
	const body = await res.text();
	expect(res.status, `${path}: ${body.slice(0, 200)}`).toBe(200);
	return { body, trips: rt.trips(), queries: rt.queries() };
}

/// Every read the page makes when the owner moves between tabs, plus the variants the
/// filters reach. The lines list is read page by page, as the page does.
const READS = [
	"/api/overview?month=2026-10",
	"/api/overview?month=2026-03&group_by=merchant",
	"/api/overview?month=2025-11",
	"/api/lines?sort=date&order=desc&from=2026-10-01&to=2026-10-31&limit=200",
	"/api/lines?sort=amount&order=desc&from=2026-03-01&to=2026-03-31&limit=50",
	"/api/lines?from=2025-10-01&to=2026-10-31&q=shop%201&limit=100",
	"/api/lines?trip=yt-2&limit=200",
	"/api/lines?account=card-t&from=2026-01-01&to=2026-06-30&limit=200",
	"/api/lines?reimbursable=true&from=2026-01-01&to=2026-12-31&limit=200",
	"/api/lines?kind=card_payment&from=2026-05-01&to=2026-05-31&limit=200",
	"/api/months",
	"/api/months?account=card-a",
	"/api/trips",
	"/api/subscriptions",
	"/api/needs-ok",
	"/api/accounts",
	"/api/wallets",
	"/api/reimbursable-ranges",
	"/api/status",
	"/api/categories",
	"/api/payments",
	"/api/statements/uploads",
];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("every page read answers exactly what it did before the speed-up", () => {
	it("byte for byte, every route and every page of the lines list", async () => {
		const got: Record<string, string> = {};
		for (const path of READS) {
			got[path] = sha((await read(path)).body);
			// Follow the lines list's pages the way the page does.
			if (path.startsWith("/api/lines")) {
				let next = (JSON.parse((await read(path)).body) as { next_cursor?: string | null }).next_cursor;
				for (let p = 2; next && p <= 4; p++) {
					const pageN = `${path}&cursor=${encodeURIComponent(next)}`;
					const r = await read(pageN);
					got[`${path} · page ${p}`] = sha(r.body);
					next = (JSON.parse(r.body) as { next_cursor?: string | null }).next_cursor;
				}
			}
		}
		if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(got, null, "\t") + "\n");
		expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
	});
});

/// The most round trips each read may make. A read the page waits on must stay
/// a handful of hops whatever the size of the ledger.
const MAX_TRIPS: Record<string, number> = {
	// A trip's own 明細: the trip and its lines come first (three hops), then the page.
	"/api/lines?trip=yt-2&limit=200": 6,
};
const DEFAULT_MAX_TRIPS = 4;

describe("every page read makes only a few round trips to D1", () => {
	it.each(READS)("%s", async (path) => {
		const r = await read(path);
		if (process.env.SHOW_TRIPS) console.log(`${String(r.trips).padStart(3)} trips ${String(r.queries).padStart(3)} queries  ${path}`);
		expect(r.trips).toBeLessThanOrEqual(MAX_TRIPS[path] ?? DEFAULT_MAX_TRIPS);
	});
});
