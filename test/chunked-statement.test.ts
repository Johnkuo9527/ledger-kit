/// The daily engine's one engine change: a statement imported in budgeted CHUNKS (the
/// worker's one-minute tick stops between lines and carries on next tick)
/// must end in exactly the state a one-go import reaches. Made-up data only.

import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { ingestEvidence, ingestStatement, type Engine, type EvidenceIn, type StatementIn, type StatementLineIn, type StatementResult } from "../src/engine";
import { CARD_A } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, addRate, testEngine } from "./helpers/world";
import { addDays } from "../src/dates";

const opened: TestDb[] = [];
afterEach(() => opened.splice(0).forEach((d) => d.close()));

/// Counts every query, as the worker's budget wrapper does.
function counted(inner: TestDb): { db: Db; count: () => number } {
	let n = 0;
	return {
		count: () => n,
		db: {
			prepare: (sql) => {
				const s = inner.prepare(sql);
				return { bind: (...v) => {
					const b = s.bind(...v);
					return { first: <T>() => (n++, b.first<T>()), all: <T>() => (n++, b.all<T>()), run: () => (n++, b.run()), inner: b } as never;
				} };
			},
			batch: (stmts) => ((n += stmts.length), inner.batch(stmts.map((s) => (s as unknown as { inner: never }).inner))),
		},
	};
}

const alert = (fp: string, date: string, currency: string, amount: number, merchant: string): EvidenceIn => ({
	type: "alert", institution: "hsbc", last4: "1111", fingerprint: fp, txn_date: date, currency, amount_minor: amount, merchant_raw: merchant, kind_hint: "purchase",
});

/// A busy made-up month on card A: foreign lines with itemised fees, a refund,
/// a payment, thirteen coffees no alert told us about, and an alert-only USD
/// estimate the statement does not carry.
function scenario(closingOffBy = 0): { before: EvidenceIn[]; st: StatementIn; lines: StatementLineIn[] } {
	const before = [
		alert("a1", "2026-03-10", "USD", 10000, "BLUE BOTTLE COFFEE"),
		alert("a2", "2026-03-14", "USD", 2000, "SHOP USA"),
		alert("a3", "2026-03-05", "SGD", 1200, "BAKERY"),
		alert("a4", "2026-03-08", "JPY", 5000, "TOKYO RAMEN"),
		alert("a5", "2026-03-11", "SGD", 3000, "BOOKSHOP"),
	];
	const lines: StatementLineIn[] = [
		{ seq: 1, txn_date: "2026-03-10", currency: "USD", amount_minor: 10000, bill_currency: "SGD", bill_minor: 13770, merchant_raw: "BLUE BOTTLE COFFEE", merchant_country: "US", kind_hint: "purchase" },
		{ seq: 2, txn_date: "2026-03-10", currency: "SGD", amount_minor: 138, merchant_raw: "FOREIGN TRANSACTION FEE", kind_hint: "fx_fee" },
		{ seq: 3, txn_date: "2026-03-05", currency: "SGD", amount_minor: 1200, merchant_raw: "BAKERY", kind_hint: "purchase" },
		{ seq: 4, txn_date: "2026-03-08", currency: "JPY", amount_minor: 5000, bill_currency: "SGD", bill_minor: 4600, merchant_raw: "TOKYO RAMEN", merchant_country: "JP", kind_hint: "purchase" },
		{ seq: 5, txn_date: "2026-03-08", currency: "SGD", amount_minor: 70, merchant_raw: "FOREIGN TRANSACTION FEE", kind_hint: "fx_fee" },
		{ seq: 6, txn_date: "2026-03-11", currency: "SGD", amount_minor: 3000, merchant_raw: "BOOKSHOP", kind_hint: "purchase" },
		{ seq: 7, txn_date: "2026-03-13", currency: "SGD", amount_minor: -3000, merchant_raw: "BOOKSHOP", kind_hint: "refund" },
		{ seq: 8, txn_date: "2026-03-01", currency: "SGD", amount_minor: -5000, merchant_raw: "PAYMENT - THANK YOU", kind_hint: "payment" },
		{ seq: 9, txn_date: "2026-03-12", currency: "USD", amount_minor: 1500, bill_currency: "SGD", bill_minor: 2050, merchant_raw: "STREAMCO US", merchant_country: "US", kind_hint: "purchase" },
		{ seq: 10, txn_date: "2026-03-12", currency: "SGD", amount_minor: 21, merchant_raw: "FOREIGN TRANSACTION FEE", kind_hint: "fx_fee" },
	];
	for (let i = 0; i < 13; i++) lines.push({ seq: 11 + i, txn_date: addDays("2026-02-17", i * 2), currency: "SGD", amount_minor: 450 + i, merchant_raw: `KOPI CORNER ${i}`, kind_hint: "purchase" });
	const net = lines.reduce((s, l) => s + (l.bill_minor ?? l.amount_minor), 0);
	const st: StatementIn = { account_id: CARD_A.id, period_start: "2026-02-16", period_end: "2026-03-15", currency: "SGD", opening_balance_minor: 5000, closing_balance_minor: 5000 + net + closingOffBy, printed_net_minor: null };
	return { before, st, lines };
}

async function world(): Promise<{ raw: TestDb; e: Engine; count: () => number }> {
	const raw = freshDb();
	opened.push(raw);
	await addAccounts(raw);
	for (let d = "2026-02-10"; d <= "2026-03-20"; d = addDays(d, 1)) {
		await addRate(raw, d, "USD", 1.35);
		await addRate(raw, d, "JPY", 0.0091);
	}
	const c = counted(raw);
	return { raw, e: { ...testEngine(raw), db: c.db }, count: c.count };
}

/// Everything the import wrote, with generated ids and timestamps replaced by
/// what the rows ARE, so two databases can be compared field by field.
async function snapshot(raw: TestDb): Promise<unknown> {
	const q = <T>(sql: string) => raw.prepare(sql).bind().all<T>().then((r) => r.results);
	const lines = await q<Record<string, unknown>>("SELECT * FROM lines");
	const statements = await q<Record<string, unknown>>("SELECT * FROM statements");
	const evidence = await q<Record<string, unknown>>("SELECT * FROM evidence");
	const names = new Map<string, string>();
	for (const s of statements) names.set(String(s.id), `S:${s.period_end}`);
	for (const l of lines) names.set(String(l.id), `L:${l.txn_date}:${l.merchant_key}:${l.orig_minor}:${l.kind}`);
	for (const ev of evidence) names.set(String(ev.id), `E:${ev.type}:${String(ev.fingerprint).replace(/stmt\|[^|]+\|/, "stmt|")}`);
	const groups = new Map<string, string>();
	const scrub = (row: Record<string, unknown>) => {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(row)) {
			if (["at", "created_at", "updated_at", "recon_checked_at", "id"].includes(k)) continue;
			if (k === "transfer_group" && typeof v === "string") out[k] = groups.get(v) ?? groups.set(v, `G${groups.size}`).get(v);
			else out[k] = typeof v === "string" ? v.replace(/(id|w)-\d{4}/g, (m) => names.get(m) ?? m) : v;
		}
		return out;
	};
	const sortBy = (rows: Record<string, unknown>[], key: (r: Record<string, unknown>) => string) => rows.map((r) => [key(r), r] as const).sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => ({ k, ...scrub(r) }));
	const events = await q<Record<string, unknown>>("SELECT * FROM line_events ORDER BY id");
	const perLine = new Map<string, unknown[]>();
	for (const ev of events) {
		const k = names.get(String(ev.line_id))!;
		(perLine.get(k) ?? perLine.set(k, []).get(k)!).push(scrub(ev));
	}
	return {
		lines: sortBy(lines, (r) => names.get(String(r.id))!),
		evidence: sortBy(evidence, (r) => names.get(String(r.id))!),
		statements: sortBy(statements, (r) => names.get(String(r.id))!),
		events: [...perLine.entries()].sort(([a], [b]) => a.localeCompare(b)),
		markups: (await q<Record<string, unknown>>("SELECT * FROM card_fx_markups ORDER BY account_id, currency")).map(scrub),
		escalations: (await q<Record<string, unknown>>("SELECT kind, ref_id, status FROM escalations ORDER BY kind, ref_id")).map(scrub),
	};
}

async function oneGo(closingOffBy = 0) {
	const { raw, e } = await world();
	const s = scenario(closingOffBy);
	for (const a of s.before) await ingestEvidence(e, a);
	const r = await ingestStatement(e, s.st, s.lines);
	return { raw, r };
}

async function inChunks(allowance: number, closingOffBy = 0) {
	const { raw, e, count } = await world();
	const s = scenario(closingOffBy);
	for (const a of s.before) await ingestEvidence(e, a);
	let calls = 0;
	let r: StatementResult;
	do {
		const start = count();
		r = await ingestStatement(e, s.st, s.lines, { budget: { remaining: () => allowance - (count() - start) } });
		calls++;
		if (calls > 200) throw new Error("the chunked import never finished");
	} while (r.status === "partial");
	return { raw, r, calls };
}

describe("a statement imported in budgeted chunks", () => {
	it("ends exactly where a one-go import ends (a month that adds up)", async () => {
		const one = await oneGo();
		expect(one.r).toMatchObject({ status: "imported", recon: { ok: true } });
		const want = await snapshot(one.raw);
		for (const allowance of [45, 60, 90, 140]) {
			const chunked = await inChunks(allowance);
			expect(chunked.r).toMatchObject({ status: "imported", recon: { ok: true } });
			expect(chunked.calls).toBeGreaterThan(1);
			expect(await snapshot(chunked.raw)).toEqual(want);
		}
	});

	it("…and a month that does not add up escalates once, chunked or not", async () => {
		const one = await oneGo(1);
		expect(one.r).toMatchObject({ status: "imported", recon: { ok: false } });
		const want = await snapshot(one.raw);
		const chunked = await inChunks(50, 1);
		expect(chunked.calls).toBeGreaterThan(3);
		expect(await snapshot(chunked.raw)).toEqual(want);
		expect((want as { escalations: { kind: string }[] }).escalations.filter((x) => x.kind === "month_failed")).toHaveLength(1);
	});

	it("never starts a line it has no budget for, and says how to go on", async () => {
		const { e } = await world();
		const s = scenario();
		const r = await ingestStatement(e, s.st, s.lines, { budget: { remaining: () => 0 } });
		expect(r).toMatchObject({ status: "partial", created: [], attached: [] });
		// The statement row exists (so the next call resumes it) and is not finished.
		const row = await e.db.prepare("SELECT recon_checked_at FROM statements").bind().first<{ recon_checked_at: string | null }>();
		expect(row).toEqual({ recon_checked_at: null });
	});

	it("a finished statement is still a duplicate", async () => {
		const { raw, r } = await oneGo();
		expect(r.status).toBe("imported");
		const e = testEngine(raw);
		const s = scenario();
		expect(await ingestStatement(e, s.st, s.lines, { budget: { remaining: () => 1000 } })).toEqual({ status: "duplicate" });
	});
});
