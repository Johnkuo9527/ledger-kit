/// Round 2 part C (meeting points C and D, ask 4): the to-the-cent bill check,
/// each card's cut-off and due day read off its statements (the owner's own word
/// wins), and a bill covering several cards (台新) split onto each card —
/// including bills already imported onto one card, read again. MADE-UP cards,
/// merchants and amounts throughout.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { billCheck, billCheckMessage } from "../src/bills";
import { ingestStatement, prepareReread, type ReadPiece, type StatementIn, type StatementLineIn } from "../src/engine";
import type { Account } from "../src/types";
import { account, CARD_A } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, testEngine } from "./helpers/world";
import type { Db } from "../src/db";

/// An engine whose ids never repeat another's in the same test.
let engines = 0;
const eng = (db: Db) => {
	const k = ++engines;
	let n = 0;
	return { ...testEngine(db), newId: () => `e${k}-${++n}` };
};

describe("the bill check", () => {
	const bill = { currency: "SGD", previous_balance_minor: 50_000, statement_balance_minor: 61_500, payments_credited_minor: 50_000 };
	const l = (amount: number, hint: string, kind: string | null = null) => ({ currency: "SGD", amount_minor: amount, bill_minor: null, kind_hint: hint, line_kind: kind });

	it("previous − payments + purchases − refunds + fees = the new balance, to the cent", () => {
		const lines = [l(-50_000, "payment"), l(60_000, "purchase"), l(-1_000, "refund"), l(2_000, "purchase"), l(500, "fee")];
		const r = billCheck(bill, lines);
		expect(r.status).toBe("ok");
		expect(r.detail).toMatchObject({ payments_minor: 50_000, purchases_minor: 62_000, refunds_minor: 1_000, fees_minor: 500, computed_minor: 61_500, difference_minor: 0 });
	});

	it("one cent off is a mismatch, said plainly", () => {
		const r = billCheck(bill, [l(-50_000, "payment"), l(61_499, "purchase")]);
		expect(r.status).toBe("mismatch");
		expect(r.detail!.difference_minor).toBe(-1);
		expect(billCheckMessage(r.detail!)).toContain("差 −SGD 0.01");
	});

	it("payments: the printed figure, else the payment lines (a card_payment line counts too)", () => {
		const noPrinted = { ...bill, payments_credited_minor: null };
		expect(billCheck(noPrinted, [l(-50_000, "purchase", "card_payment"), l(61_500, "purchase")]).status).toBe("ok");
	});

	it("cannot be checked without both balances", () => {
		expect(billCheck({ ...bill, previous_balance_minor: null }, []).status).toBeNull();
	});
});

describe("in the ledger", () => {
	let db: TestDb;
	beforeEach(async () => {
		db = freshDb();
		await addAccounts(db);
	});
	afterEach(() => db.close());
	const acct = (id: string) => db.raw.prepare("SELECT statement_day, due_day, settings_source FROM accounts WHERE id = ?").get(id);
	const line = (seq: number, date: string, amount: number, merchant: string, hint: StatementLineIn["kind_hint"] = "purchase"): StatementLineIn => ({ seq, txn_date: date, currency: "SGD", amount_minor: amount, merchant_raw: merchant, kind_hint: hint });

	it("a card bill's figures, its bill check and the card's days come from the statement", async () => {
		const st: StatementIn = {
			account_id: CARD_A.id, period_start: "2026-08-26", period_end: "2026-09-25", currency: "SGD",
			opening_balance_minor: 10_000, closing_balance_minor: 13_000, printed_net_minor: null,
			previous_balance_minor: 10_000, statement_balance_minor: 13_000, minimum_due_minor: 5_000, payments_credited_minor: 10_000, due_date: "2026-10-15", bill_group: "m1:0", bill_primary: 1,
		};
		const r = await ingestStatement(testEngine(db), st, [line(1, "2026-09-01", -10_000, "PAYMENT THANK YOU", "payment"), line(2, "2026-09-03", 13_000, "BOOKSHOP")]);
		expect(r.status).toBe("imported");
		expect(db.raw.prepare("SELECT bill_check, minimum_due_minor, due_date FROM statements").get()).toEqual({ bill_check: "ok", minimum_due_minor: 5_000, due_date: "2026-10-15" });
		expect(acct(CARD_A.id)).toEqual({ statement_day: 25, due_day: 15, settings_source: "statement" });
	});

	it("The owner's own days are never overwritten by a statement; an older statement never moves them back", async () => {
		db.raw.prepare("UPDATE accounts SET statement_day = 3, due_day = 28, settings_source = 'owner' WHERE id = ?").run(CARD_A.id);
		const st = (end: string): StatementIn => ({ account_id: CARD_A.id, period_start: "2026-08-01", period_end: end, currency: "SGD", opening_balance_minor: 0, closing_balance_minor: 100, printed_net_minor: null, due_date: "2026-10-20" });
		await ingestStatement(eng(db), st("2026-09-25"), [line(1, "2026-09-02", 100, "SHOP")]);
		expect(acct(CARD_A.id)).toEqual({ statement_day: 3, due_day: 28, settings_source: "owner" });
		db.raw.prepare("UPDATE accounts SET statement_day = NULL, due_day = NULL, settings_source = NULL WHERE id = ?").run(CARD_A.id);
		await ingestStatement(eng(db), { ...st("2026-10-25"), due_date: null }, [line(1, "2026-10-02", 100, "SHOP")]);
		await ingestStatement(eng(db), { ...st("2026-08-25"), period_start: "2026-07-26" }, [line(1, "2026-08-02", 100, "SHOP")]);
		expect(acct(CARD_A.id)).toEqual({ statement_day: 25, due_day: null, settings_source: "statement" }); // the newest printed no due date; the older one never moves the days
	});
});

// 台新-like: one bill lists every card. Made-up cards: OLD (lost, replaced by NEW), NEW, OTHER.
describe("one bill, several cards", () => {
	const t = (id: string, last4: string, over: Partial<Account> = {}) => account({ id, institution: "taishin", kind: "credit_card", currency: "TWD", last4, alerts_expected: 0, ...over });
	const OLD = t("tw-old", "5504", { active: 0 });
	const NEW = t("tw-new", "5506");
	const OTHER = t("tw-other", "5510");
	let db: TestDb;
	beforeEach(async () => {
		db = freshDb();
		await addAccounts(db, [OLD, NEW, OTHER]);
		db.raw.prepare("UPDATE accounts SET replaced_by = 'tw-new' WHERE id = 'tw-old'").run();
		db.raw.prepare("INSERT INTO messages (gmail_id, received_at, classification, processed_at) VALUES ('gm-1', '2026-09-16T00:00:00Z', 'statement', '2026-09-16T00:00:00Z')").run();
	});
	afterEach(() => db.close());

	const L = (seq: number, date: string, amount: number, merchant: string, hint: StatementLineIn["kind_hint"] = "purchase"): StatementLineIn => ({ seq, txn_date: date, currency: "TWD", amount_minor: amount, merchant_raw: merchant, kind_hint: hint, details: { seq } });
	const all = [L(1, "2026-08-20", -900, "PAYMENT RECEIVED", "payment"), L(2, "2026-08-21", 300, "NIGHT MARKET"), L(3, "2026-08-22", 500, "BOOK STORE"), L(4, "2026-08-25", 700, "TEA HOUSE"), L(5, "2026-08-28", 200, "BAKERY TW")];
	const base = { period_start: "2026-08-16", period_end: "2026-09-15", currency: "TWD", message_id: "gm-1", attachment_name: "bill.pdf" } as const;
	const linesOn = (acc: string) => (db.raw.prepare("SELECT merchant_raw FROM lines WHERE account_id = ? ORDER BY merchant_raw").all(acc) as { merchant_raw: string }[]).map((x) => x.merchant_raw);

	it("a bill imported onto the old card, read again: each line moves to its card; the bill adds up; twice changes nothing", async () => {
		// The first reading (before round 2): everything on the old card.
		const first = await ingestStatement(eng(db), { ...base, account_id: OLD.id, opening_balance_minor: 900, closing_balance_minor: 1_700, printed_net_minor: null }, all);
		expect(first.status).toBe("imported");
		expect(linesOn(NEW.id)).toEqual([]);
		// The second reading names each line's card: 2,3 on NEW; 4 on OTHER; 1,5 stay on the bill's own (OLD).
		const pieces: ReadPiece[] = [
			{ st: { ...base, account_id: OLD.id, opening_balance_minor: null, closing_balance_minor: null, printed_net_minor: -700, previous_balance_minor: 900, statement_balance_minor: 1_700, minimum_due_minor: 170, payments_credited_minor: 900, due_date: "2026-10-03", bill_group: "gm-1:0", bill_primary: 1 }, lines: [all[0]!, all[4]!] },
			{ st: { ...base, account_id: NEW.id, opening_balance_minor: null, closing_balance_minor: null, printed_net_minor: 800, due_date: null, bill_group: "gm-1:0", bill_primary: 0 }, lines: [all[1]!, all[2]!] },
			{ st: { ...base, account_id: OTHER.id, opening_balance_minor: null, closing_balance_minor: null, printed_net_minor: 700, due_date: null, bill_group: "gm-1:0", bill_primary: 0 }, lines: [all[3]!] },
		];
		const prep = await prepareReread(eng(db), pieces);
		expect(prep.moved).toBe(3);
		for (const p of prep.pieces) expect((await ingestStatement(eng(db), p.st, p.lines)).status).toBe("imported");
		expect(linesOn(OLD.id)).toEqual(["BAKERY TW", "PAYMENT RECEIVED"]);
		expect(linesOn(NEW.id)).toEqual(["BOOK STORE", "NIGHT MARKET"]);
		expect(linesOn(OTHER.id)).toEqual(["TEA HOUSE"]);
		const rows = db.raw.prepare("SELECT account_id, recon_status, bill_group, bill_primary, bill_check FROM statements ORDER BY account_id").all();
		expect(rows).toEqual([
			{ account_id: NEW.id, recon_status: "reconciled", bill_group: "gm-1:0", bill_primary: 0, bill_check: null },
			{ account_id: OLD.id, recon_status: "reconciled", bill_group: "gm-1:0", bill_primary: 1, bill_check: "ok" },
			{ account_id: OTHER.id, recon_status: "reconciled", bill_group: "gm-1:0", bill_primary: 0, bill_check: null },
		]);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM evidence").get()).toEqual({ n: 5 }); // nothing added
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM line_events WHERE event = 'resplit'").get()).toEqual({ n: 3 });
		// The new card takes the bill's days (one card with the old one); the other card too.
		expect(db.raw.prepare("SELECT id, statement_day, due_day FROM accounts ORDER BY id").all()).toEqual([
			{ id: NEW.id, statement_day: 15, due_day: 3 },
			{ id: OLD.id, statement_day: 15, due_day: 3 },
			{ id: OTHER.id, statement_day: 15, due_day: 3 },
		]);
		// Read again a second time: nothing moves.
		const again = await prepareReread(eng(db), pieces);
		expect(again.moved).toBe(0);
		for (const p of again.pieces) await ingestStatement(eng(db), p.st, p.lines);
		expect(linesOn(NEW.id)).toEqual(["BOOK STORE", "NIGHT MARKET"]);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM statements").get()).toEqual({ n: 3 });
	});

	it("a new reading that numbers lines differently, or leaves one out: nothing is lost, the left-out line stays", async () => {
		await ingestStatement(eng(db), { ...base, account_id: OLD.id, opening_balance_minor: 900, closing_balance_minor: 1_700, printed_net_minor: null }, all);
		// The new reading misses line 2 and numbers the rest 1–4, so BAKERY takes the place the left-out line holds; lines 3 and 4 name NEW.
		const re = (l: StatementLineIn, seq: number) => ({ ...l, seq, details: { seq } });
		const pieces: ReadPiece[] = [
			{ st: { ...base, account_id: OLD.id, opening_balance_minor: null, closing_balance_minor: null, printed_net_minor: -700, bill_group: "gm-1:0", bill_primary: 1 }, lines: [re(all[0]!, 1), re(all[4]!, 2)] },
			{ st: { ...base, account_id: NEW.id, opening_balance_minor: null, closing_balance_minor: null, printed_net_minor: 1_200, bill_group: "gm-1:0", bill_primary: 0 }, lines: [re(all[2]!, 3), re(all[3]!, 4)] },
		];
		const prep = await prepareReread(eng(db), pieces);
		expect(prep.moved).toBe(2);
		for (const p of prep.pieces) await ingestStatement(eng(db), p.st, p.lines);
		expect(linesOn(NEW.id)).toEqual(["BOOK STORE", "TEA HOUSE"]);
		expect(linesOn(OLD.id)).toEqual(["BAKERY TW", "NIGHT MARKET", "PAYMENT RECEIVED"]); // the left-out line stays where it was
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM evidence").get()).toEqual({ n: 5 });
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM lines").get()).toEqual({ n: 5 });
	});

	it("a new reading that disagrees on the statement date moves nothing", async () => {
		await ingestStatement(eng(db), { ...base, account_id: OLD.id, opening_balance_minor: 900, closing_balance_minor: 1_700, printed_net_minor: null }, all);
		const prep = await prepareReread(eng(db), [{ st: { ...base, period_end: "2026-09-14", account_id: NEW.id, opening_balance_minor: null, closing_balance_minor: null, printed_net_minor: 800, bill_group: "gm-1:0", bill_primary: 0 }, lines: [all[1]!] }]);
		expect(prep).toEqual({ pieces: [], moved: 0 });
		expect(linesOn(OLD.id)).toHaveLength(5);
		expect(db.raw.prepare("SELECT bill_group FROM statements").get()).toEqual({ bill_group: "gm-1:0" });
	});
});
