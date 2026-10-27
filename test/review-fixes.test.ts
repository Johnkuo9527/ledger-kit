/// One test per defect the adversarial review found, each proving the fix.
/// All data MADE UP.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bound, Db, RunResult } from "../src/db";
import { insertRow } from "../src/db";
import { changeLine, correctHome, getLine, ingestEvidence, ingestStatement, ingestTap, retryHeldTaps, type Engine, type EvidenceIn } from "../src/engine";
import { ACCOUNT_INSERT, accountValues } from "../src/seed";
import { walletKey } from "../src/shortcut";
import type { LineRow } from "../src/types";
import { ACCOUNTS, CARD_A, CARD_T, evidence } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";

let db: TestDb;
let e: Engine;

beforeEach(async () => {
	db = freshDb();
	for (const a of ACCOUNTS) await db.prepare(ACCOUNT_INSERT).bind(...accountValues(a)).run();
	await db.prepare("INSERT INTO fx_rates (date, currency, quote, rate, source) VALUES ('2026-03-10', 'TWD', 'SGD', 0.042, 'test')").bind().run();
	let tick = 0;
	let ids = 0;
	e = {
		db,
		now: () => new Date(Date.UTC(2026, 9, 9, 0, 0, 0, tick++)).toISOString(),
		newId: () => `id-${String(++ids).padStart(4, "0")}`,
		ownNames: [],
		aliases: [],
		actor: "rules",
	};
});
afterEach(() => db.close());

const alert = (fp: string, over: Partial<EvidenceIn> = {}): EvidenceIn => ({
	type: "alert",
	institution: "hsbc",
	last4: "1111",
	fingerprint: fp,
	txn_date: "2026-03-10",
	currency: "SGD",
	amount_minor: 1000,
	merchant_raw: "SHOP",
	kind_hint: "purchase",
	...over,
});

/// The same database, but the worker "dies" on the n-th batch.
function dyingAfter(inner: Db, n: number): Db {
	let calls = 0;
	return {
		prepare: (sql) => inner.prepare(sql),
		async batch(stmts: Bound[]): Promise<RunResult[]> {
			if (++calls === n) throw new Error("worker killed mid-import");
			return inner.batch(stmts);
		},
	};
}

describe("a crash half-way never leaves a month half-imported", () => {
	it("re-running the statement finishes it, without a single duplicate line", async () => {
		await ingestEvidence(e, alert("a1", { merchant_raw: "KOPI", amount_minor: 450 }));
		const st = { account_id: CARD_A.id, period_start: "2026-02-16", period_end: "2026-03-15", currency: "SGD", opening_balance_minor: 0, closing_balance_minor: 2450, printed_net_minor: null };
		const printed = [
			{ seq: 1, txn_date: "2026-03-10", currency: "SGD", amount_minor: 450, merchant_raw: "KOPI", kind_hint: "purchase" as const },
			{ seq: 2, txn_date: "2026-03-11", currency: "SGD", amount_minor: 1000, merchant_raw: "BOOKS", kind_hint: "purchase" as const },
			{ seq: 3, txn_date: "2026-03-12", currency: "SGD", amount_minor: 1000, merchant_raw: "BOOKS", kind_hint: "purchase" as const },
		];
		// Dies on the 3rd batch: line 1 attached, line 2 created, line 3 not yet.
		await expect(ingestStatement({ ...e, db: dyingAfter(db, 3) }, st, printed)).rejects.toThrow(/killed/);
		expect((await db.prepare("SELECT recon_checked_at FROM statements").bind().first())!.recon_checked_at).toBeNull();

		const again = await ingestStatement(e, st, printed);
		expect(again.status === "imported" && again.recon).toMatchObject({ ok: true, ledger_minor: 2450 });
		expect((await db.prepare("SELECT COUNT(*) AS n FROM lines").bind().first())!.n).toBe(3);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE type = 'statement_line'").bind().first())!.n).toBe(3);
		// And once finished, a third run really is a duplicate.
		expect(await ingestStatement(e, st, printed)).toEqual({ status: "duplicate" });
	});

	it("an alert stored but never attached is taken up again, not dropped as a duplicate", async () => {
		// The evidence row landed; the worker died before the line was made.
		await insertRow(db, "evidence", evidence({ id: "half", type: "alert", fingerprint: "a2", amount_minor: 1000, txn_date: "2026-03-10" })).run();
		const r = await ingestEvidence(e, alert("a2"));
		expect(r).toMatchObject({ status: "created", evidence_id: "half" });
		expect(await ingestEvidence(e, alert("a2"))).toEqual({ status: "duplicate" });
	});
});

describe("The owner's SGD figure is his", () => {
	it("survives a rules write that read the line just before his correction", async () => {
		const tap = await ingestTap(e, { card: "x", merchant: "y", amount: "NT$100", timestamp: "2026-03-10T10:00:00+08:00" });
		expect(tap.status).toBe("held"); // no Wallet name yet — make the line by alert instead
		const r = await ingestEvidence(e, alert("t1", { institution: "taishin", last4: CARD_T.last4, currency: "TWD", amount_minor: 10000 }));
		const id = (r as { line_id: string }).line_id;
		const stale = (await getLine(db, id))!; // the daily run reads the line…
		await correctHome(e, id, 450); // …the owner corrects it…
		await changeLine(e, stale, { home_minor: 420, home_status: "reference", note: "rules were here" }, "test"); // …the run writes.
		expect(await getLine(db, id)).toMatchObject({ home_minor: 450, home_status: "confirmed", home_set_by: "owner", note: "rules were here" });
	});
});

describe("held taps are retried once the owner names the Wallet card", () => {
	it("attaches, and closes the question it raised", async () => {
		await ingestTap(e, { card: "New Card", merchant: "Kopi", amount: "S$4.50", timestamp: "2026-03-10T08:00:00+08:00" });
		expect(await retryHeldTaps(e)).toEqual([]); // still unknown: nothing happens
		await db.prepare("INSERT INTO account_wallet_names (wallet_key, account_id) VALUES (?, ?)").bind(walletKey("New Card"), CARD_A.id).run();
		const [r] = await retryHeldTaps(e);
		expect(r).toMatchObject({ status: "created" });
		expect(await getLine(db, (r as { line_id: string }).line_id)).toMatchObject({ account_id: CARD_A.id, orig_minor: 450 });
		expect((await db.prepare("SELECT status FROM escalations WHERE kind = 'unknown_wallet_card'").bind().first())!.status).toBe("resolved");
	});
});

describe("Cloudflare's 100-value limit", () => {
	it("a receipt is matched across 120 same-week lines without one oversized query", async () => {
		for (let i = 0; i < 120; i++) {
			await ingestEvidence(e, alert(`bulk-${i}`, { merchant_raw: `SHOP ${String.fromCharCode(65 + (i % 26))}${i}`, amount_minor: 2000 + i }));
		}
		await ingestEvidence(e, alert("target", { merchant_raw: "BOOKSHOP", amount_minor: 2590 }));
		const r = await ingestEvidence(e, { type: "receipt", fingerprint: "receipt|bookshop.example|9", txn_date: "2026-03-10", currency: "SGD", amount_minor: 2590, merchant_raw: "Bookshop" });
		expect(r).toMatchObject({ status: "attached" });
		const lines = (await db.prepare("SELECT * FROM lines").bind().all<LineRow>()).results;
		expect(lines).toHaveLength(121);
	});
});
