/// The read side (src/queries.ts) on a real in-memory database with the real
/// migrations. Every figure is MADE UP and every expected total was worked by
/// hand in the comment above it before the code ran.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reimbursable } from "../src/reimbursable";
import {
	decodeCursor,
	DEFAULT_LINE_SORT,
	type LineCursor,
	type LineSort,
	filterSql,
	likeFragment,
	linePage,
	lineViews,
	loadLines,
	monthBounds,
	monthViews,
	needsOk,
	oneTripView,
	overview,
	subscriptionsView,
	countFor,
	groupTotals,
	groupTotalsFor,
	membersFor,
	totalsFor,
	tripMembers,
	viewContext,
	UNCATEGORISED,
	type LineFilter,
} from "../src/queries";
import { isSpending } from "../src/transfers";
import type { LineRow } from "../src/types";
import { totals, type TripRow } from "../src/views";
import { BANK, CARD_A, CARD_C, CASH, DEBIT, evidence, line, statement } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, put, subscriptionRow, TAISHIN_NO_EMAIL, tripRow } from "./helpers/world";

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
});
afterEach(() => db.close());

async function lines(...rows: LineRow[]): Promise<void> {
	for (const r of rows) await put(db, "lines", r);
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();

/// One March for most tests.
///   M1  card A  03-05  Kopi Corner     SGD 4.50   exact     Food
///   M2  card A  03-10  GitHub (US)     USD 10.00 → est SGD 13.94   Software, not on statement
///   M3  card A  03-12  refund of M1   −SGD 4.50   Food
///   M4  bank    03-15  card payment    SGD 20.00  (never spending)
///   M5  cash    03-20  Hawker          SGD 12.00  no category
///   M6  card A  02-28  outside March   SGD 9.99
///   M7  card A  03-08  VOID            SGD 50.00
///   M8  bank    03-10  transfer        SGD 30.00  (never spending)
///   M9  debit   03-18  Bakery          SGD 3.00   no category
const M = {
	M1: line({ id: "M1", txn_date: "2026-03-05", merchant_raw: "KOPI CORNER", merchant_key: "KOPI CORNER", merchant_name: "Kopi Corner", orig_minor: 450, bill_minor: 450, home_minor: 450, category: "Food", reimbursable_override: 1 }),
	M2: line({ id: "M2", txn_date: "2026-03-10", merchant_raw: "GITHUB.COM", merchant_key: "GITHUB", merchant_name: "Github", merchant_country: "US", orig_currency: "USD", orig_minor: 1000, bill_minor: 1394, bill_status: "estimate", home_minor: 1394, home_status: "estimate", category: "Software", flag_not_on_statement: 1 }),
	M3: line({ id: "M3", kind: "refund", txn_date: "2026-03-12", merchant_raw: "KOPI CORNER", merchant_key: "KOPI CORNER", merchant_name: "Kopi Corner", orig_minor: -450, bill_minor: -450, home_minor: -450, category: "Food", refund_of: "M1" }),
	M4: line({ id: "M4", account_id: BANK.id, kind: "card_payment", txn_date: "2026-03-15", merchant_raw: "HSBC CARD PAYMENT", merchant_key: "HSBC CARD", merchant_name: "Hsbc Card", orig_minor: 2000, bill_minor: 2000, home_minor: 2000 }),
	M5: line({ id: "M5", account_id: CASH.id, txn_date: "2026-03-20", merchant_raw: "HAWKER", merchant_key: "HAWKER", merchant_name: "Hawker", orig_minor: 1200, bill_minor: 1200, home_minor: 1200 }),
	M6: line({ id: "M6", txn_date: "2026-02-28", orig_minor: 999, bill_minor: 999, home_minor: 999 }),
	M7: line({ id: "M7", txn_date: "2026-03-08", state: "void", orig_minor: 5000, bill_minor: 5000, home_minor: 5000 }),
	M8: line({ id: "M8", account_id: BANK.id, kind: "transfer", txn_date: "2026-03-10", merchant_raw: "TRANSFER", merchant_key: "TRANSFER", merchant_name: "Transfer", orig_minor: 3000, bill_minor: 3000, home_minor: 3000 }),
	M9: line({ id: "M9", account_id: DEBIT.id, txn_date: "2026-03-18", merchant_raw: "BAKERY", merchant_key: "BAKERY", merchant_name: "Bakery", orig_minor: 300, bill_minor: 300, home_minor: 300 }),
};

async function march(): Promise<void> {
	await lines(...Object.values(M));
}

describe("filters", () => {
	beforeEach(march);

	it("never lists a void line", async () => {
		expect(ids(await loadLines(db, {}))).toEqual(["M1", "M2", "M3", "M4", "M5", "M6", "M8", "M9"]);
	});

	it("date range, account, kind and category", async () => {
		expect(ids(await loadLines(db, { from: "2026-03-01", to: "2026-03-31" }))).toEqual(["M1", "M2", "M3", "M4", "M5", "M8", "M9"]);
		expect(ids(await loadLines(db, { account_id: BANK.id }))).toEqual(["M4", "M8"]);
		expect(ids(await loadLines(db, { kind: "refund" }))).toEqual(["M3"]);
		expect(ids(await loadLines(db, { category: "Food" }))).toEqual(["M1", "M3"]);
		// "Uncategorised" finds the lines with no category at all.
		expect(ids(await loadLines(db, { category: UNCATEGORISED, from: "2026-03-01" }))).toEqual(["M4", "M5", "M8", "M9"]);
	});

	it("merchant text matches name, raw descriptor or note, in any case", async () => {
		expect(ids(await loadLines(db, { merchant: "kopi" }))).toEqual(["M1", "M3"]);
		expect(ids(await loadLines(db, { merchant: "github.com" }))).toEqual(["M2"]);
	});

	it("a % or _ typed by the owner is a character, not a wildcard", async () => {
		expect(await loadLines(db, { merchant: "%" })).toEqual([]);
		expect(await loadLines(db, { merchant: "_" })).toEqual([]);
	});

	it("flags, any of them", async () => {
		expect(ids(await loadLines(db, { flags: ["not_on_statement"] }))).toEqual(["M2"]);
		expect(ids(await loadLines(db, { flags: ["no_rate", "unlinked_refund"] }))).toEqual([]);
	});

	it("reimbursable in SQL says exactly what reimbursable() says, for every line", async () => {
		await put(db, "reimburse_ranges", { id: "R1", start_date: "2026-03-09", end_date: "2026-03-11", note: null, created_at: "2026-01-01T00:00:00.000Z" });
		// M1 by override; M2 inside the range; M8 is inside it too but a transfer is never spending.
		expect(ids(await loadLines(db, { reimbursable: true }))).toEqual(["M1", "M2"]);
		const ranges = [{ id: "R1", start_date: "2026-03-09", end_date: "2026-03-11", note: null }];
		for (const l of await loadLines(db, {})) {
			const yes = ids(await loadLines(db, { reimbursable: true })).includes(l.id);
			const no = ids(await loadLines(db, { reimbursable: false })).includes(l.id);
			expect([l.id, yes]).toEqual([l.id, reimbursable(l, ranges).effective]);
			expect(yes).toBe(!no);
		}
	});

	it("provisional in SQL says exactly what LineView.provisional says, for every line", async () => {
		const all = await loadLines(db, {});
		const views = await lineViews(db, all);
		const yes = ids(await loadLines(db, { provisional: true }));
		const no = ids(await loadLines(db, { provisional: false }));
		for (const v of views) {
			expect([v.id, yes.includes(v.id)]).toEqual([v.id, v.provisional]);
			expect(no.includes(v.id)).toBe(!v.provisional);
		}
		// Cash never has a statement coming; the card, the bank and the debit card (via its bank) do.
		expect(yes).toEqual(["M1", "M2", "M3", "M4", "M6", "M8", "M9"]);
	});

	it("only these lines (a trip's), bound as ONE value however many there are", async () => {
		const many = [...Array.from({ length: 150 }, (_, i) => `nope-${i}`), "M5"];
		const f: LineFilter = { line_ids: many };
		expect(filterSql(f).args).toHaveLength(1);
		expect(ids(await loadLines(db, f))).toEqual(["M5"]);
	});
});

describe("the database's sum of a filter is totals() of its lines", () => {
	beforeEach(march);

	it.each<[string, LineFilter]>([
		["everything", {}],
		["March", { from: "2026-03-01", to: "2026-03-31" }],
		["card A", { account_id: CARD_A.id }],
		["Food", { category: "Food" }],
		["nothing", { merchant: "no such shop" }],
		["refunds", { kind: "refund" }],
	])("%s", async (_name, f) => {
		await put(db, "lines", line({ id: "NR", txn_date: "2026-03-03", flag_no_rate: 1, home_status: "reference", home_minor: 777, orig_minor: 777, bill_minor: 777, category: "Food" }));
		expect(await totalsFor(db, f)).toEqual(totals(await loadLines(db, f)));
	});
});

describe("the merchant search fits D1's 50-byte LIKE cap", () => {
	it("cuts at 44 bytes, never inside a character", () => {
		expect(likeFragment("台".repeat(20))).toBe("台".repeat(14)); // 14 × 3 = 42 bytes; a 15th would be 45
		expect(new TextEncoder().encode(likeFragment("x".repeat(80))).length).toBe(44);
		expect(likeFragment("😀".repeat(20))).toBe("😀".repeat(11)); // 11 × 4 = 44
	});

	it("escapes the wildcards, and counts the escape against the budget", () => {
		expect(likeFragment("50%_off\\")).toBe("50\\%\\_off\\\\");
		expect(new TextEncoder().encode(likeFragment("%".repeat(40))).length).toBe(44); // 22 escaped
	});

	it("every bound pattern of a long Chinese search is at most 50 bytes", () => {
		const { args } = filterSql({ merchant: "台新銀行信用卡消費全聯福利中心台北市中正區分店" });
		for (const a of args) expect(new TextEncoder().encode(String(a)).length).toBeLessThanOrEqual(50);
	});
});

describe("paging through lines", () => {
	beforeEach(march);

	it("newest first, no line twice, none skipped, and the cursor round-trips", async () => {
		const seen: string[] = [];
		let cursor: LineCursor | null = null;
		for (let i = 0; i < 10; i++) {
			const page = await linePage(db, {}, 3, cursor);
			seen.push(...page.lines.map((l) => l.id));
			if (!page.next_cursor) break;
			cursor = decodeCursor(page.next_cursor);
			expect(cursor).not.toBeNull();
		}
		expect(seen).toEqual((await loadLines(db, {}, "date")).map((l) => l.id));
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen[0]).toBe("M5"); // 03-20 is the newest
	});

	it("refuses a cursor it did not make", () => {
		expect(decodeCursor("not-a-cursor")).toBeNull();
		expect(decodeCursor(btoa("[1,2,3]"))).toBeNull();
		expect(decodeCursor(btoa('["amount","desc","x","2026-03-01","t","id"]'))).toBeNull();
	});

	const pageAll = async (sort: LineSort, size: number, f = {}) => {
		const seen: LineRow[] = [];
		let cursor: LineCursor | null = null;
		for (let i = 0; i < 50; i++) {
			const page = await linePage(db, f, size, cursor, sort);
			seen.push(...page.lines);
			if (!page.next_cursor) break;
			cursor = decodeCursor(page.next_cursor);
		}
		return seen;
	};

	it("biggest spending first: spending only, by SGD, every line once, at any page size (ties included)", async () => {
		await put(db, "lines", line({ id: "TIE1", txn_date: "2026-03-07", home_minor: 777, bill_minor: 777, orig_minor: 777 }));
		await put(db, "lines", line({ id: "TIE2", txn_date: "2026-03-07", home_minor: 777, bill_minor: 777, orig_minor: 777 }));
		await put(db, "lines", line({ id: "BILL", kind: "card_payment", txn_date: "2026-03-07", home_minor: 99_999, bill_minor: 99_999, orig_minor: 99_999 }));
		const spending = (await loadLines(db, {})).filter(isSpending);
		const want = [...spending].sort((a, b) => b.home_minor - a.home_minor || b.txn_date.localeCompare(a.txn_date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).map((l) => l.id);
		for (const size of [1, 2, 3, 50]) {
			const got = (await pageAll({ by: "amount", order: "desc" }, size)).map((l) => l.id);
			expect(got).toEqual(want);
		}
		expect((await pageAll({ by: "amount", order: "asc" }, 2)).map((l) => l.id)).toEqual([...want].reverse());
		// A kind named in the filter is listed even though it is not spending.
		expect((await pageAll({ by: "amount", order: "desc" }, 2, { kind: "card_payment" })).map((l) => l.id)).toContain("BILL");
		// Oldest first by date works too, and is the newest-first list reversed.
		const newest = (await pageAll({ by: "date", order: "desc" }, 2)).map((l) => l.id);
		expect((await pageAll({ by: "date", order: "asc" }, 2)).map((l) => l.id)).toEqual([...newest].reverse());
	});

	it("a cursor from one sort is refused by another; an old newest-first cursor still works", async () => {
		const first = await linePage(db, {}, 1, null, { by: "amount", order: "desc" });
		const c = decodeCursor(first.next_cursor!)!;
		await expect(linePage(db, {}, 1, c, { by: "date", order: "desc" })).rejects.toThrow(/another sort/);
		const old = btoa(JSON.stringify(["2026-03-20", "2099-01-01T00:00:00.000Z", "ZZZ"])).replaceAll("=", "");
		expect(decodeCursor(old)).toEqual({ sort: DEFAULT_LINE_SORT, key: ["2026-03-20", "2099-01-01T00:00:00.000Z", "ZZZ"] });
	});
});

describe("the month overview", () => {
	beforeEach(march);

	it("groups by category (default) or merchant, biggest first, with each one's share of the month", async () => {
		const o = await overview(db, "2026-03", "2026-10-09");
		expect(o.group_by).toBe("category");
		expect(o.groups.map((g) => g.key)).toEqual(o.categories.map((c) => c.category));
		const total = o.totals.spending_home.minor;
		for (const g of o.groups) expect(g.share_pct).toBe(Math.round((g.spending_home.minor / total) * 1000) / 10);
		expect(o.groups[0]!.share_pct).toBe(51.8); // Uncategorised 15.00 of 28.94
		const m = await overview(db, "2026-03", "2026-10-09", "merchant");
		expect(m.group_by).toBe("merchant");
		expect(m.groups.reduce((a, g) => a + g.count, 0)).toBe(o.totals.count);
		expect(m.groups.reduce((a, g) => a + g.spending_home.minor, 0)).toBe(total);
		const sorted = [...m.groups].sort((a, b) => b.spending_home.minor - a.spending_home.minor);
		expect(m.groups.map((g) => g.spending_home.minor)).toEqual(sorted.map((g) => g.spending_home.minor));
		const empty = await overview(db, "2025-01", "2026-10-09");
		expect(empty.groups).toEqual([]);
	});

	it("totals, categories and accounts, by hand", async () => {
		// Spending in March: M1 4.50 + M2 13.94 + M3 −4.50 + M5 12.00 + M9 3.00 = 28.94 (5 lines).
		// Still an estimate: M2 13.94. M4 (card bill) and M8 (transfer) never count; M7 is void.
		const o = await overview(db, "2026-03", "2026-10-09");
		expect(o).toMatchObject({ month: "2026-03", from: "2026-03-01", to: "2026-03-31" });
		expect(o.totals).toEqual({
			spending_home: { currency: "SGD", minor: 2894, display: "SGD 28.94" },
			count: 5,
			unconfirmed_home: { currency: "SGD", minor: 1394, display: "SGD 13.94" },
			missing_rate_count: 0,
		});
		// Uncategorised = M5 12.00 + M9 3.00 = 15.00 (2); Software 13.94 (1); Food 4.50 − 4.50 = 0 (2).
		expect(o.categories.map((c) => [c.category, c.spending_home.minor, c.count])).toEqual([
			[UNCATEGORISED, 1500, 2],
			["Software", 1394, 1],
			["Food", 0, 2],
		]);
		expect(o.categories[1]!.unconfirmed_home.minor).toBe(1394);
		// Card A: 4.50 + 13.94 − 4.50 = 13.94; cash 12.00; debit 3.00.
		expect(o.by_account.map((a) => [a.account_id, a.spending_home.minor])).toEqual([
			[CARD_A.id, 1394],
			[CASH.id, 1200],
			[DEBIT.id, 300],
		]);
		// Reimbursable: only M1, by the owner's override — 4.50.
		expect(o.reimbursable_home.minor).toBe(450);
		// With 03-09…03-11 as a range, M2 (13.94) joins; M8 is in it too but a transfer is never spending: 4.50 + 13.94 = 18.44.
		await put(db, "reimburse_ranges", { id: "R1", start_date: "2026-03-09", end_date: "2026-03-11", note: null, created_at: "2026-01-01T00:00:00.000Z" });
		expect((await overview(db, "2026-03", "2026-10-09")).reimbursable_home).toEqual({ currency: "SGD", minor: 1844, display: "SGD 18.44" });
	});

	it("says how complete each account is; 台新 is complete only to its statement", async () => {
		await put(db, "statements", statement({ id: "ST", account_id: TAISHIN_NO_EMAIL.id, period_start: "2026-02-26", period_end: "2026-03-25", currency: "TWD" }));
		const o = await overview(db, "2026-04", "2026-04-10");
		const t = o.coverage.find((c) => c.account_id === TAISHIN_NO_EMAIL.id)!;
		expect(t).toMatchObject({ mode: "statement_only", partial: true, complete_through: "2026-03-25" });
		expect(t.message).toContain("up to date as of the statement of 2026-03-25");
		expect(o.coverage.find((c) => c.account_id === CARD_A.id)).toMatchObject({ mode: "live", partial: false });
		// An empty month is zero with its coverage, never an error.
		expect(o.totals.count).toBe(0);
		expect(o.coverage).toHaveLength(7);
	});

	it("台新 between statements is a note, a late statement a warning with its reason (14 Oct 2026)", async () => {
		const at = (d: string) => `${d}T02:00:00.000Z`;
		await put(db, "messages", { gmail_id: "gm-mar", thread_id: null, from_addr: "estatement@bank.example", subject: "bill", received_at: at("2026-03-28"), classification: "statement", processed_at: at("2026-03-28"), error: null });
		await put(db, "statements", statement({ id: "ST", account_id: TAISHIN_NO_EMAIL.id, period_start: "2026-02-26", period_end: "2026-03-25", currency: "TWD", message_id: "gm-mar" }));
		const cov = async (month: string, today: string) => (await overview(db, month, today)).coverage.find((c) => c.account_id === TAISHIN_NO_EMAIL.id)!;
		// Between statements: not late, the honest note — complete to 03-25, the rest comes about 04-25.
		expect(await cov("2026-04", "2026-04-10")).toMatchObject({ partial: true, overdue: false, complete_through: "2026-03-25", next_statement_due: "2026-04-25", overdue_reason: null });
		// Late (after 05-05), and no mail from its statement sender since the last one arrived.
		expect(await cov("2026-05", "2026-05-10")).toMatchObject({ partial: true, overdue: true, overdue_reason: { kind: "no_mail", since: "2026-03-28" } });
		// A newer statement mail that is still being read; then one that could not be read.
		await put(db, "messages", { gmail_id: "gm-apr", thread_id: null, from_addr: "estatement@bank.example", subject: "bill", received_at: at("2026-04-28"), classification: "statement", processed_at: at("2026-04-28"), error: null });
		await put(db, "work", { gmail_id: "gm-apr", source: "daily", month: null, kind: "statement", stage: "ingest", attempts: 0, not_before: null, park_until_month: null, payload_json: null, error: null, created_at: at("2026-04-28"), updated_at: at("2026-04-28") });
		expect((await cov("2026-05", "2026-05-10")).overdue_reason).toEqual({ kind: "reading", since: null });
		db.raw.prepare("UPDATE work SET stage = 'failed', error = 'x' WHERE gmail_id = 'gm-apr'").run();
		expect((await cov("2026-05", "2026-05-10")).overdue_reason).toEqual({ kind: "read_failed", since: null });
		// The bank's PDF-password alarm stays open while ANY of its bills is locked, an
		// older one too: a newer mail that could not be read still explains it better.
		await put(db, "alarms", { key: "pdf_password:TAISHIN", message: "x", raised_at: at("2026-04-29"), cleared_at: null, notified_at: null });
		expect((await cov("2026-05", "2026-05-10")).overdue_reason).toEqual({ kind: "read_failed", since: null });
		// The newer mail is the locked one: the alarm says it best, since it was raised.
		db.raw.prepare("UPDATE work SET stage = 'waiting', error = 'pdf password' WHERE gmail_id = 'gm-apr'").run();
		const late = await cov("2026-05", "2026-05-10");
		expect(late.overdue_reason).toEqual({ kind: "pdf_password", since: "2026-04-29" });
		expect(late.message).toContain("its PDF would not open");
		// Nothing newer from its address at all (the locked bill came from another one): the alarm, as before.
		db.raw.prepare("DELETE FROM work WHERE gmail_id = 'gm-apr'").run();
		db.raw.prepare("DELETE FROM messages WHERE gmail_id = 'gm-apr'").run();
		expect((await cov("2026-05", "2026-05-10")).overdue_reason).toEqual({ kind: "pdf_password", since: "2026-04-29" });
		// A past month the statement covers is complete: nothing to say.
		expect(await cov("2026-02", "2026-05-10")).toMatchObject({ partial: false, overdue: false });
	});

	it("knows a month", () => {
		expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
		expect(monthBounds("2026-13")).toBeNull();
		expect(monthBounds("2026-3")).toBeNull();
	});
});

describe("statements (months)", () => {
	it("newest first; a debit card's months are its bank's", async () => {
		await put(db, "statements", statement({ id: "B1", account_id: BANK.id, period_end: "2026-02-28" }));
		await put(db, "statements", statement({ id: "B2", account_id: BANK.id, period_end: "2026-03-31", recon_status: "escalated" }));
		await put(db, "statements", statement({ id: "A1", account_id: CARD_A.id, period_end: "2026-03-15" }));
		expect((await monthViews(db)).map((m) => m.statement_id)).toEqual(["B2", "A1", "B1"]);
		expect((await monthViews(db, DEBIT.id)).map((m) => m.statement_id)).toEqual(["B2", "B1"]);
		expect(await monthViews(db, CASH.id)).toEqual([]);
		expect(await monthViews(db, "no-such-account")).toEqual([]);
	});
});

describe("trips", () => {
	/// T1, 03-09 → 03-13, proposed by a flight receipt whose line is FB (paid in January).
	///   FB  card C  01-20  Test Air      SGD 500.00  the booking → member, whenever paid
	///   T2  card A  03-10  USD 10 → 13.94 (JP)       overseas, in the dates → member
	///   T3  card A  03-11  Netflix SGD 15.98         in the dates but at home → not a member
	///   T4  card A  03-12  USD 5 → 6.97 (JP)         overseas, in the dates, EXCLUDED by the owner
	///   T5  card A  03-01  Insurance SGD 30.00       before the trip, INCLUDED by the owner
	///   T6  card C  04-02  refund of FB −SGD 100.00  a refund belongs where its purchase is
	///   T7  card A  03-20  USD 7 → 9.76 (JP)         overseas, after the trip → not a member
	beforeEach(async () => {
		await lines(
			line({ id: "FB", account_id: CARD_C.id, txn_date: "2026-01-20", merchant_name: "Test Air", orig_minor: 50000, bill_minor: 50000, home_minor: 50000 }),
			line({ id: "T2", txn_date: "2026-03-10", merchant_country: "JP", orig_currency: "USD", orig_minor: 1000, bill_minor: 1394, bill_status: "estimate", home_minor: 1394, home_status: "estimate" }),
			line({ id: "T3", txn_date: "2026-03-11", merchant_name: "Netflix", orig_minor: 1598, bill_minor: 1598, home_minor: 1598 }),
			line({ id: "T4", txn_date: "2026-03-12", merchant_country: "JP", orig_currency: "USD", orig_minor: 500, bill_minor: 697, home_minor: 697 }),
			line({ id: "T5", txn_date: "2026-03-01", merchant_name: "Insurance", orig_minor: 3000, bill_minor: 3000, home_minor: 3000 }),
			line({ id: "T6", account_id: CARD_C.id, kind: "refund", txn_date: "2026-04-02", refund_of: "FB", orig_minor: -10000, bill_minor: -10000, home_minor: -10000 }),
			line({ id: "T7", txn_date: "2026-03-20", merchant_country: "JP", orig_currency: "USD", orig_minor: 700, bill_minor: 976, home_minor: 976 }),
		);
		await put(db, "evidence", evidence({ id: "EVF", type: "receipt", line_id: "FB", fingerprint: "flight", txn_date: "2026-01-20" }));
		await put(db, "trips", tripRow({ id: "TR1", status: "confirmed", evidence_ids_json: '["EVF"]' }));
		await put(db, "trip_lines", { trip_id: "TR1", line_id: "T4", membership: "excluded" });
		await put(db, "trip_lines", { trip_id: "TR1", line_id: "T5", membership: "included" });
	});

	it("gathers bookings, overseas spending in its dates, the owner's includes and the refunds — minus his excludes", async () => {
		const trip = (await db.prepare("SELECT * FROM trips WHERE id = 'TR1'").bind().first())! as never;
		expect(ids(await tripMembers(db, trip))).toEqual(["FB", "T2", "T5", "T6"]);
	});

	it("its view is the true cost: 500.00 + 13.94 + 30.00 − 100.00 = 443.94, of which 13.94 is still an estimate", async () => {
		const v = (await oneTripView(db, "TR1"))!;
		expect(v.trip).toMatchObject({ id: "TR1", status: "confirmed", line_count: 4, total_home: { minor: 44394 }, unconfirmed_home: { minor: 1394 } });
		expect(await oneTripView(db, "nope")).toBeNull();
	});

	it("a line knows its trip — the confirmed one beats a proposed one over the same days", async () => {
		await put(db, "trips", tripRow({ id: "TR0", status: "proposed", start_date: "2026-03-10", end_date: "2026-03-10" }));
		const ctx = await viewContext(db);
		expect(ctx.tripOf.get("T2")).toBe("TR1");
		expect(ctx.tripOf.get("T3")).toBeUndefined();
		const [v] = await lineViews(db, [(await loadLines(db, { line_ids: ["T2"] }))[0]!], ctx);
		expect(v!.trip_id).toBe("TR1");
	});

	it("a dismissed trip claims no line", async () => {
		await db.prepare("UPDATE trips SET status = 'dismissed' WHERE id = 'TR1'").bind().run();
		expect((await viewContext(db)).tripOf.size).toBe(0);
	});
});

describe("subscriptions", () => {
	it("the monthly total uses each one's latest real SGD charge, skips what the owner set aside, and says what it could not price", async () => {
		// S1 SGD monthly, latest charge 15.99 → 15.99 a month.
		// S2 USD yearly, latest charge cost SGD 32.70 on the card → 32.70 ÷ 12 = 2.725 → 2.73 (half away from zero... Math.round(272.5) = 273).
		// S3 ignored by the owner → not in the total, not in "active".
		// S4 USD monthly whose charge line is missing → left out, and counted as missing.
		// Total: 15.99 + 2.73 = 18.72.
		await lines(line({ id: "S1c", home_minor: 1599, orig_minor: 1599, bill_minor: 1599 }), line({ id: "S2b", orig_currency: "USD", orig_minor: 2400, bill_minor: 3270, home_minor: 3270 }));
		await put(db, "subscriptions", subscriptionRow({ id: "S1", merchant_key: "STREAMCO", merchant_name: "Streamco", amount_minor: 1599, line_ids_json: '["S1a","S1b","S1c"]' }));
		await put(db, "subscriptions", subscriptionRow({ id: "S2", merchant_key: "DOMAINCO", merchant_name: "Domainco", currency: "USD", cadence: "yearly", amount_minor: 2400, line_ids_json: '["S2a","S2b"]' }));
		await put(db, "subscriptions", subscriptionRow({ id: "S3", merchant_key: "GYMCO", merchant_name: "Gymco", amount_minor: 999, owner_status: "ignored", line_ids_json: '["S3a"]' }));
		await put(db, "subscriptions", subscriptionRow({ id: "S4", merchant_key: "TOOLCO", merchant_name: "Toolco", currency: "USD", amount_minor: 500, line_ids_json: '["gone"]' }));
		const active = await subscriptionsView(db, "active");
		expect(active.subscriptions.map((s) => s.id)).toEqual(["S2", "S1", "S4"]);
		expect(active.monthly_total_home).toEqual({ currency: "SGD", minor: 1872, display: "SGD 18.72" });
		expect(active.monthly_total_missing).toBe(1);
		const all = await subscriptionsView(db, "all");
		expect(all.subscriptions.map((s) => [s.id, s.status])).toEqual([
			["S2", "active"],
			["S3", "ignored"],
			["S1", "active"],
			["S4", "active"],
		]);
	});
});

describe("what is waiting on the owner", () => {
	it("proposed trips, held taps, lines to look at and months that did not add up", async () => {
		await lines(line({ id: "R1", state: "review" }), line({ id: "R2", flag_unlinked_refund: 1, kind: "refund", orig_minor: -100, bill_minor: -100, home_minor: -100 }), line({ id: "OK", txn_date: "2026-03-02" }));
		await put(db, "trips", tripRow({ id: "P1", status: "proposed" }));
		await put(db, "trips", tripRow({ id: "C1", status: "confirmed", start_date: "2025-01-01", end_date: "2025-01-05" }));
		await put(db, "evidence", evidence({ id: "TAP", type: "apple_pay_shortcut", fingerprint: "tap-1", currency: "SGD", amount_minor: 450, merchant_raw: "Kopi", txn_time: "08:15", details_json: JSON.stringify({ wallet_key: "MYSTERY CARD" }) }));
		await put(db, "evidence", evidence({ id: "ALR", type: "alert", fingerprint: "alert-1" }));
		await put(db, "statements", statement({ id: "BAD", account_id: CARD_A.id, recon_status: "escalated" }));
		await put(db, "statements", statement({ id: "GOOD", account_id: CARD_A.id, period_end: "2026-04-15", recon_status: "reconciled" }));
		const n = await needsOk(db);
		expect(n.trips.map((t) => t.id)).toEqual(["P1"]);
		const { actions: tapActions, ...tap } = n.held_taps[0]!;
		expect(n.held_taps).toHaveLength(1);
		expect(tap).toEqual({ evidence_id: "TAP", card: "MYSTERY CARD", merchant: "Kopi", amount: { currency: "SGD", minor: 450, display: "SGD 4.50" }, date: "2026-03-05", time: "08:15", received_at: "2026-01-01T00:00:00.000Z" });
		// Round 2 (A): every item carries the buttons that answer it.
		expect(tapActions.map((a) => [a.id, a.path, a.choice_key ?? null])).toEqual([["assign", "/api/wallet-names", "account_id"], ["dismiss", "/api/needs-ok/held/TAP/dismiss", null]]);
		expect(tapActions[0]!.choices!.map((c) => c.value)).toContain(CARD_A.id);
		expect(n.trips[0]!.actions.map((a) => a.path)).toEqual(["/api/trips/P1/confirm", "/api/trips/P1/reject"]);
		expect(ids(n.lines)).toEqual(["R1", "R2"]);
		expect(n.lines.find((l) => l.id === "R1")!.flags).toContain("needs_review");
		expect(n.lines.find((l) => l.id === "R1")!.actions.map((a) => [a.id, a.body.action])).toEqual([["accept", "accept"], ["void", "void"]]);
		expect(n.lines.find((l) => l.id === "R2")!.actions.map((a) => [a.id, a.choice_key ?? null])).toEqual([["link", "refund_of"], ["accept", null]]); // purchases of the same payee to pick from
		expect(n.months.map((m) => [m.statement_id, m.actions.map((a) => a.path)])).toEqual([["BAD", ["/api/months/BAD/reviewed", "/api/months/BAD/recheck"]]]);
		expect(n.held.map((h) => [h.id, h.actions.map((a) => a.path)])).toEqual([["ALR", ["/api/needs-ok/held/ALR/dismiss"]]]);
		expect(n.pdf_passwords).toEqual([]);
		expect(n.other_held).toBe(0); // every held item is listed
		expect(n.count).toBe(6);
		for (const list of [n.trips, n.held_taps, n.lines, n.months, n.held]) for (const item of list) for (const a of item.actions) expect(a).toMatchObject({ method: "POST", style: expect.stringMatching(/^(primary|secondary|danger)$/) });
	});
});

describe("the database does the adding, and the answers agree with the code", () => {
	beforeEach(march);

	it.each(["category", "merchant", "account", "month"] as const)("groupTotalsFor(%s) = groupTotals of the same lines", async (by) => {
		const accounts = (await viewContext(db)).accounts;
		for (const f of [{}, { from: "2026-03-01", to: "2026-03-31" }, { account_id: CARD_A.id }] as LineFilter[]) {
			expect(await groupTotalsFor(db, f, by, accounts)).toEqual(groupTotals(await loadLines(db, f), by, accounts));
		}
	});

	it("countFor counts every matching line, spending or not", async () => {
		expect(await countFor(db, { from: "2026-03-01", to: "2026-03-31" })).toBe(7);
		expect(await countFor(db, { merchant: "nothing like it" })).toBe(0);
	});
});

describe("trip membership is read in a fixed number of queries", () => {
	/// Counts every statement that reaches the database (a batch counts each of its statements).
	function counting(inner: TestDb): { db: TestDb; queries: () => number } {
		let n = 0;
		return {
			queries: () => n,
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

	async function trips(count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			const d = `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 20) + 1).padStart(2, "0")}`;
			await put(db, "lines", line({ id: `TL${i}`, txn_date: d, merchant_country: "JP", orig_currency: "JPY", orig_minor: 1000 + i, bill_minor: 900, home_minor: 900 }));
			await put(db, "trips", tripRow({ id: `TR${i}`, status: i % 3 ? "confirmed" : "proposed", start_date: d, end_date: d }));
		}
	}

	it("1 trip or 40 trips: the same number of queries for a page's line views", async () => {
		await trips(1);
		const one = counting(db);
		await lineViews(one.db, await loadLines(db, {}));
		await db.raw.exec("DELETE FROM trips; DELETE FROM lines WHERE id LIKE 'TL%'");
		await trips(40);
		const forty = counting(db);
		const views = await lineViews(forty.db, await loadLines(db, {}));
		expect(forty.queries()).toBe(one.queries());
		expect(forty.queries()).toBeLessThanOrEqual(10);
		expect(views.find((v) => v.id === "TL39")!.trip_id).toBe("TR39");
	});

	it("reading many trips at once gives each exactly what reading it alone gives", async () => {
		await trips(12);
		await put(db, "trip_lines", { trip_id: "TR1", line_id: "TL5", membership: "included" });
		await put(db, "trip_lines", { trip_id: "TR2", line_id: "TL2", membership: "excluded" });
		const all = (await db.prepare("SELECT * FROM trips").bind().all<TripRow>()).results;
		const together = await membersFor(db, all);
		for (const t of all) expect([t.id, ids(together.get(t.id)!)]).toEqual([t.id, ids(await tripMembers(db, t))]);
		expect(ids(together.get("TR1")!)).toEqual(["TL1", "TL5"]);
		expect(ids(together.get("TR5")!)).toEqual(["TL5"]);
		expect(together.get("TR2")).toEqual([]);
	});
});
