/// The worker's test bench: the foundation's in-memory SQLite (every real migration
/// applied), a pinned clock, a mail catcher, a memory stand-in for the OAuth
/// library's KV store, and a made-up world of accounts and lines.
/// Nothing here can reach a real database, a real inbox or the live desk.

import type { SeedFile } from "../../../src/seed";
import { BankList } from "../../../src/bank-list";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { Bound, Db } from "../../../src/db";
import { addCash, ingestTap, type Engine } from "../../../src/engine";
import { freshDb, type TestDb } from "../../../test/helpers/sqlite-db";
import { evidence, line, statement } from "../../../test/helpers/fixtures";
import { addAccounts, addRate, addWallet, put, subscriptionRow, testEngine, tripRow } from "../../../test/helpers/world";
import type { Ctx, Deps, LedgerEnv } from "../../src/env";
import type { PageAssets } from "../../src/page";
import { COOKIE, mintCookie } from "../../src/session";

/// The example seed's bank list (DBS, HSBC, Citi, 台新 and their domains) —
/// what freshDb() loads into every test database.
export const EXAMPLE_BANKS = BankList.from((JSON.parse(readFileSync(fileURLToPath(new URL("../../../seed/accounts.example.json", import.meta.url)), "utf8")) as SeedFile).banks);

export const BASE = "https://ledger.test.workers.dev";
export const UNLOCK_KEY = "unlock-key-made-up-for-tests-0123456789abcdef";
export const SESSION_SECRET = "session-secret-made-up-for-tests-fedcba9876543210";
export const TAP_KEY = "shortcut-key-made-up-for-tests-00112233445566778899";
export const OWNER = "owner@example.com";
export const NOW = "2026-10-09T02:00:00.000Z"; // 10:00 in Singapore

/// The one string that is only ever in Design's page (the test bundle's).
export const PAGE_TELL = "LEDGER-PAGE-TELL";
export const TEST_ASSETS: PageAssets = {
	"index.html": { type: "text/html; charset=utf-8", body: `<!doctype html><title>t</title><div>${PAGE_TELL}</div><script src="app.js"></script>` },
	"app.js": { type: "text/javascript; charset=utf-8", body: "/* page script */" },
	"icon.png": { type: "image/png", body: "iVBORw0KGgo=", base64: true },
};

export interface Mailbox {
	sent: { to: string[]; subject: string; text: string; from: string }[];
}

export function makeDeps(start = NOW): Deps & { mail: Mailbox; advance(ms: number): void; failMail: boolean } {
	let t = new Date(start).getTime();
	let ids = 0;
	const mail: Mailbox = { sent: [] };
	const deps = {
		mail,
		failMail: false,
		advance(ms: number) {
			t += ms;
		},
		now: () => new Date(t),
		newId: () => `w-${String(++ids).padStart(4, "0")}`,
		sleep: async () => {},
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url !== "https://api.resend.com/emails") throw new Error(`test made an unexpected network call: ${url}`);
			if (deps.failMail) return new Response("{}", { status: 500 });
			mail.sent.push(JSON.parse(String(init?.body)));
			return new Response('{"id":"x"}', { status: 200 });
		}) as typeof fetch,
	};
	return deps;
}

/// D1 caps a LIKE pattern at 50 UTF-8 bytes and answers SQLITE_ERROR past it;
/// the SQLite in the tests does not. This wrapper does, so a search that would
/// crash on the live database crashes here first.
export function withLikeCap(db: TestDb): TestDb {
	return {
		...db,
		prepare(sql: string) {
			const stmt = db.prepare(sql);
			if (!/\bLIKE\b/i.test(sql)) return stmt;
			return {
				bind(...values: unknown[]) {
					for (const v of values) {
						if (typeof v === "string" && v.includes("%") && new TextEncoder().encode(v).length > 50) throw new Error(`D1: LIKE pattern over 50 bytes (${v})`);
					}
					return stmt.bind(...values);
				},
			};
		},
		batch: (s) => db.batch(s),
		close: () => db.close(),
		raw: db.raw,
	};
}

export function makeEnv(db: Db, over: Partial<LedgerEnv> & Record<string, unknown> = {}): LedgerEnv {
	return {
		LEDGER_DB: db,
		LEDGER_UNLOCK_KEY: UNLOCK_KEY,
		LEDGER_SESSION_SECRET: SESSION_SECRET,
		LEDGER_SHORTCUT_KEY: TAP_KEY,
		LEDGER_OWNER_EMAIL: OWNER,
		RESEND_API_KEY: "re_made_up",
		// The kit's first home; a test about another home passes its own.
		LEDGER_HOME_CURRENCY: "SGD",
		LEDGER_TIMEZONE: "Asia/Singapore",
		LEDGER_HOME_COUNTRY: "SG",
		// The kit's first language; a test about English passes LEDGER_LANGUAGE: "en".
		LEDGER_LANGUAGE: "zh-Hant",
		...over,
	};
}

export const CTX: Ctx = { waitUntil() {}, passThroughOnException() {} };

/// The cookie header a signed-in browser sends.
export async function signedIn(now = new Date(NOW), secret = SESSION_SECRET): Promise<string> {
	const set = await mintCookie(secret, now);
	return set.split(";")[0]!;
}

export function get(path: string, cookie?: string, headers: Record<string, string> = {}): Request {
	return new Request(BASE + path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
}

export function post(path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}): Request {
	return new Request(BASE + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

export { COOKIE };

/// The OAuth library's KV store, in memory, with TTLs honoured on read.
export class MemoryKV {
	private data = new Map<string, { value: string; expires: number | null }>();
	constructor(private clock: () => number = () => Date.now()) {}
	async get(key: string, opts?: unknown): Promise<unknown> {
		const hit = this.data.get(key);
		if (!hit || (hit.expires !== null && hit.expires <= this.clock())) return null;
		const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
		return type === "json" ? JSON.parse(hit.value) : hit.value;
	}
	async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }): Promise<void> {
		const expires = opts?.expirationTtl ? this.clock() + opts.expirationTtl * 1000 : opts?.expiration ? opts.expiration * 1000 : null;
		this.data.set(key, { value, expires });
	}
	async delete(key: string): Promise<void> {
		this.data.delete(key);
	}
	async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
		const names = [...this.data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
		return { keys: names.map((name) => ({ name })), list_complete: true };
	}
	keys(): string[] {
		return [...this.data.keys()];
	}
}

// ------------------------------------------------------------------ the world

/// A made-up month of the owner's ledger, every figure invented:
///   tap on card A (Wallet "Test Rewards"):  Kopi Corner SGD 4.50, 2026-10-02
///   tap on card A:                           Bookshop SGD 30.00, 2026-10-03
///   cash:                                    Hawker SGD 12.00, 2026-10-04
///   a 台新 line at the reference rate:        TWD 1,000.00 → SGD 42.00, 2026-10-05
///   a held tap from an unknown Wallet card:  "Mystery Card" SGD 8.00
///   a proposed trip to Testville 2026-09-10 → 09-14 with a booking line (card C, SGD 500.00, 2026-08-01)
///   a confirmed trip 2026-06-01 → 06-05
///   an active SGD subscription (Streamco 15.99/month) and an escalated statement on card A
export interface World {
	engine: Engine;
	kopi: string;
	book: string;
	cash: string;
	twd: string;
	booking: string;
}

export async function seedWorld(db: TestDb): Promise<World> {
	await addAccounts(db);
	await addWallet(db, "Test Rewards", "card-a");
	await addRate(db, "2026-10-05", "TWD", 0.042);
	const engine = testEngine(db);
	const tap = async (merchant: string, amount: string, ts: string) => {
		const r = await ingestTap(engine, { card: "Test Rewards", merchant, amount, timestamp: ts });
		if (r.status !== "created") throw new Error(`seed tap: ${JSON.stringify(r)}`);
		return r.line_id;
	};
	const kopi = await tap("Kopi Corner", "S$4.50", "2026-10-02T08:15:00+08:00");
	const book = await tap("Bookshop", "S$30.00", "2026-10-03T12:00:00+08:00");
	const cash = (await addCash({ ...engine, actor: "owner" }, { txn_date: "2026-10-04", currency: "SGD", amount_minor: 1200, merchant: "Hawker" })).id;
	await put(db, "lines", line({ id: "twd-1", account_id: "card-t", txn_date: "2026-10-05", orig_currency: "TWD", orig_minor: 100000, bill_currency: "TWD", bill_minor: 100000, home_minor: 4200, home_status: "reference", home_rate: 0.042, merchant_name: "Night Market" }));
	const held = await ingestTap(engine, { card: "Mystery Card", merchant: "Corner Shop", amount: "S$8.00", timestamp: "2026-10-06T09:00:00+08:00" });
	if (held.status !== "held") throw new Error("seed: the mystery tap should be held");
	await put(db, "lines", line({ id: "booking-1", account_id: "card-c", txn_date: "2026-08-01", merchant_name: "Test Air", orig_minor: 50000, bill_minor: 50000, home_minor: 50000 }));
	await put(db, "evidence", evidence({ id: "ev-flight", type: "receipt", line_id: "booking-1", fingerprint: "receipt|test|flight", txn_date: "2026-08-01" }));
	await put(db, "trips", tripRow({ id: "trip-p", destination: "Testville, JP", start_date: "2026-09-10", end_date: "2026-09-14", status: "proposed", evidence_ids_json: '["ev-flight"]' }));
	await put(db, "trips", tripRow({ id: "trip-c", name: "Old trip", destination: "Elsewhere, TH", start_date: "2026-06-01", end_date: "2026-06-05", status: "confirmed", confirmed_at: "2026-06-06T00:00:00.000Z" }));
	await put(db, "lines", line({ id: "sub-3", txn_date: "2026-09-15", merchant_name: "Streamco", orig_minor: 1599, bill_minor: 1599, home_minor: 1599 }));
	await put(db, "subscriptions", subscriptionRow({ id: "sub-s", merchant_key: "STREAMCO", merchant_name: "Streamco", amount_minor: 1599, line_ids_json: '["sub-1","sub-2","sub-3"]', last_charged: "2026-09-15", next_renewal: "2026-10-15" }));
	await put(db, "statements", statement({ id: "st-bad", account_id: "card-a", period_start: "2026-08-16", period_end: "2026-09-15", recon_status: "escalated" }));
	return { engine, kopi, book, cash, twd: "twd-1", booking: "booking-1" };
}

export async function json(res: Response): Promise<Record<string, unknown> & { ok?: unknown; message?: unknown }> {
	return (await res.json()) as Record<string, unknown>;
}

/// Counts every statement that reaches the database; a batch counts each of
/// its statements (the conservative reading of D1's per-request limit).
export function countingDb(inner: TestDb): { db: TestDb; queries: () => number; reset: () => void } {
	let n = 0;
	return {
		queries: () => n,
		reset: () => {
			n = 0;
		},
		db: {
			...inner,
			prepare(sql: string) {
				const stmt = inner.prepare(sql);
				return {
					bind(...v: unknown[]) {
						const b = stmt.bind(...v);
						return {
							first: <T>() => (n++, b.first<T>()),
							all: <T>() => (n++, b.all<T>()),
							run: () => (n++, b.run()),
						};
					},
				};
			},
			batch: (s) => ((n += s.length), inner.batch(s)),
		},
	};
}

/// Counts each query once and each statement of a batch once — exactly what
/// D1 counts — sitting UNDER the tick's BudgetDb (countingDb above counts a
/// batch's statements twice, the conservative reading for the 40-query pages).
export function exactCountingDb(inner: TestDb): { db: TestDb; queries: () => number; reset: () => void } {
	let n = 0;
	type Inner = Bound & { inner?: Bound };
	return {
		queries: () => n,
		reset: () => {
			n = 0;
		},
		db: {
			...inner,
			prepare(sql: string) {
				const stmt = inner.prepare(sql);
				return {
					bind(...v: unknown[]) {
						const b = stmt.bind(...v);
						const counted: Inner = { inner: b, first: <T>() => (n++, b.first<T>()), all: <T>() => (n++, b.all<T>()), run: () => (n++, b.run()) };
						return counted;
					},
				};
			},
			batch: (s) => ((n += s.length), inner.batch(s.map((x) => (x as Inner).inner ?? x))),
		},
	};
}

/// Counts D1 ROUND TRIPS, not queries (20 Oct 2026: tabs took 3–5 s live).
/// Every call made before the event loop next turns over leaves in the same
/// round trip — what `Promise.all` over D1 does live — and a call that waited
/// for an earlier answer is a new one. Live, each round trip is a hop from the
/// worker to the database, so a page's wait grows with this number, not with
/// the query count. Deterministic: no clocks, only the order of calls.
export function roundTripDb(inner: TestDb): { db: TestDb; trips: () => number; queries: () => number; reset: () => void } {
	let trips = 0;
	let queries = 0;
	let queue: (() => void)[] = [];
	const leave = () =>
		new Promise<void>((resolve) => {
			queries++;
			if (!queue.length) {
				trips++;
				setImmediate(() => {
					const go = queue;
					queue = [];
					for (const f of go) f();
				});
			}
			queue.push(resolve);
		});
	type Inner = Bound & { inner?: Bound };
	return {
		trips: () => trips,
		queries: () => queries,
		reset: () => {
			trips = 0;
			queries = 0;
		},
		db: {
			...inner,
			prepare(sql: string) {
				const stmt = inner.prepare(sql);
				return {
					bind(...v: unknown[]) {
						const b = stmt.bind(...v);
						const out: Inner = {
							inner: b,
							first: async <T>() => (await leave(), b.first<T>()),
							all: async <T>() => (await leave(), b.all<T>()),
							run: async () => (await leave(), b.run()),
						};
						return out;
					},
				};
			},
			batch: async (s) => {
				await leave();
				queries += s.length - 1;
				return inner.batch(s.map((x) => (x as Inner).inner ?? x));
			},
		},
	};
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/// The 13 months of `seedYear`, oldest first (2025-10 … 2026-10).
export const YEAR_MONTHS = Array.from({ length: 13 }, (_, i) => {
	const d = new Date(Date.UTC(2025, 9 + i, 1));
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
});
export const YEAR_CATEGORIES = ["Food", "Supermarket", "Drinks", "Transportation", "Grab/Uber", "Clothes", "Snacks", "Others"];

/// A made-up year the size of the owner's (20 Oct 2026): the world above plus
/// 300 lines a month for 13 months over every kind of account, a statement a month
/// per card, six trips, eight subscriptions. Every id is fixed, so two runs give
/// byte-identical answers. Every figure and name is invented.
export async function seedYear(db: TestDb): Promise<number> {
	await seedWorld(db);
	let n = 0;
	const accts = ["card-a", "card-b", "card-c", "card-t", "cash", "debit-x"];
	const kinds = ["purchase", "purchase", "purchase", "purchase", "purchase", "purchase", "refund", "investment", "friend_transfer", "card_payment"] as const;
	for (const [mi, m] of YEAR_MONTHS.entries()) {
		for (let i = 0; i < 300; i++) {
			const acct = accts[i % accts.length]!;
			const day = `${m}-${pad2((i % 28) + 1)}`;
			const twd = acct === "card-t";
			const kind = kinds[(i + mi) % kinds.length]!;
			const amt = (kind === "refund" ? -1 : 1) * (300 + ((i * 37 + mi * 11) % 9000));
			await put(db, "lines", line({
				id: `y-${m}-${pad2(Math.floor(i / 100))}${pad2(i % 100)}`, account_id: acct, kind, txn_date: day, created_at: `${day}T0${i % 10}:00:00.000Z`,
				merchant_name: `Shop ${i % 120}`, merchant_key: `SHOP ${i % 120}`, merchant_raw: `SHOP ${i % 120}`,
				category: kind === "purchase" || kind === "refund" ? YEAR_CATEGORIES[i % YEAR_CATEGORIES.length]! : null,
				orig_currency: twd ? "TWD" : "SGD", bill_currency: twd ? "TWD" : "SGD", orig_minor: twd ? amt * 23 : amt, bill_minor: twd ? amt * 23 : amt,
				home_minor: amt,
				...(twd ? { home_status: "reference", home_rate: 0.042 } : {}),
				...(i % 97 === 0 ? { state: "review" } : {}),
				...(i % 89 === 0 ? { flag_not_on_statement: 1 } : {}),
				...(i % 13 === 0 ? { reimbursable_override: 1 } : {}),
			}));
			n++;
		}
		for (const a of ["card-a", "card-b", "card-c", "card-t"]) {
			await put(db, "statements", statement({ id: `ys-${a}-${m}`, account_id: a, currency: a === "card-t" ? "TWD" : "SGD", period_start: `${m}-01`, period_end: `${m}-14`, due_date: `${m}-28`, recon_status: "reconciled", statement_balance_minor: 50000, minimum_due_minor: 5000 }));
		}
	}
	for (let i = 0; i < 6; i++) await put(db, "trips", tripRow({ id: `yt-${i}`, name: `Trip ${i}`, start_date: `${YEAR_MONTHS[i * 2]}-03`, end_date: `${YEAR_MONTHS[i * 2]}-08`, status: "confirmed", confirmed_at: "2026-01-01T00:00:00.000Z" }));
	for (let i = 0; i < 8; i++) await put(db, "subscriptions", subscriptionRow({ id: `ysub-${i}`, merchant_key: `SHOP ${i}`, merchant_name: `Shop ${i}`, amount_minor: 1000 + i, line_ids_json: "[]", last_charged: "2026-09-15", next_renewal: "2026-10-15" }));
	return n;
}
