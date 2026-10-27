/// Round 2 part C, ask 4: one 台新 bill lists every 台新 card. A new reading
/// splits it per card by each line's last 4 digits; a bill imported before
/// round 2 (everything on the old, lost card) is sent to be read once more by
/// the look back and its lines move to their cards. MADE-UP cards, amounts.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { account, line } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts, put } from "../../test/helpers/world";
import { workQueue } from "../src/pipeline";
import { foldOneBill, oneBillNote, statementsFromAnswer } from "../src/read";
import type { StatementAnswer } from "../src/schemas";
import { runTick } from "../src/tick";
import { lookBack, REREAD_MAX } from "../src/upkeep";
import { FakeClaude, MODELS } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { makeDeps, makeEnv } from "./helpers/harness";

const PDF = new Uint8Array(readFileSync(new URL("./fixtures/statement-aes-256.pdf", import.meta.url)));
const PW = "made-up-pw-1234";
const t = (id: string, last4: string, active: 0 | 1 = 1) => account({ id, institution: "taishin", kind: "credit_card", currency: "TWD", last4, alerts_expected: 0, active });
const OLD = t("tw-old", "5504", 0);
const NEW = t("tw-new", "5506");
const OTHER = t("tw-other", "5510");

type Line = StatementAnswer["statements"][number]["lines"][number];
const L = (seq: number, date: string, amount: string, description: string, card: string | null, direction: "out" | "in" = "out", kind_hint: Line["kind_hint"] = "purchase"): Line => ({
	seq, date, post_date: null, description, currency: "TWD", amount, bill_currency: null, bill_amount: null, direction, country: "TW", kind_hint, card_last4: card,
});
/// The bill as the reader reports it: one section (addressed to the old card), lines naming their card — or not (a first, pre-round-2 reading).
const answer = (cards: boolean): StatementAnswer => ({
	institution: "taishin",
	statements: [
		{
			last4: "5504", period_start: "2026-08-16", period_end: "2026-09-15", currency: "TWD",
			opening_balance: "900", opening_is_credit: false, closing_balance: "1,700", closing_is_credit: false,
			minimum_due: cards ? "170" : null, due_date: cards ? "2026-10-03" : null, payments_credited: cards ? "900" : null,
			lines: [
				L(1, "2026-08-20", "900", "PAYMENT RECEIVED", null, "in", "payment"),
				L(2, "2026-08-21", "300", "NIGHT MARKET", cards ? "5506" : null),
				L(3, "2026-08-22", "500", "BOOK STORE", cards ? "5506" : null),
				L(4, "2026-08-25", "700", "TEA HOUSE", cards ? "5510" : null),
				L(5, "2026-08-28", "200", "BAKERY TW", cards ? "5504" : null),
			],
		},
	],
	confidence: "sure",
	note: "",
});

describe("reading a bill that lists several cards", () => {
	it("splits it per card: the bill's own card first with the bill's figures, every other card with its own lines", () => {
		const r = statementsFromAnswer(answer(true), [OLD, NEW, OTHER], "gm-1", "bill.pdf", null);
		expect(r.adds_up).toBe(true); // the bill as printed: 900 − 900 + 1,700 = 1,700
		expect(r.read.map((x) => [x.st.account_id, x.st.bill_primary, x.st.printed_net_minor, x.lines.map((l) => l.seq)])).toEqual([
			["tw-old", 1, 20_000 - 90_000, [1, 5]],
			["tw-new", 0, 80_000, [2, 3]],
			["tw-other", 0, 70_000, [4]],
		]);
		const [primary, other] = [r.read[0]!.st, r.read[1]!.st];
		expect(primary).toMatchObject({ bill_group: "gm-1:0", previous_balance_minor: 90_000, statement_balance_minor: 170_000, minimum_due_minor: 17_000, payments_credited_minor: 90_000, due_date: "2026-10-03", opening_balance_minor: null, closing_balance_minor: null });
		expect(other).toMatchObject({ bill_group: "gm-1:0", previous_balance_minor: null, statement_balance_minor: null, due_date: null });
	});

	it("an auto-debit payment printed under another card's heading stays on the bill's own card (14 Oct 2026)", () => {
		const a = answer(true);
		a.statements[0]!.lines[0] = L(1, "2026-08-27", "900", "台新銀行帳戶自動轉帳扣繳台新信用卡款", "5510", "in", "payment");
		const r = statementsFromAnswer(a, [OLD, NEW, OTHER], "gm-1", "bill.pdf", null);
		expect(r.read.map((x) => [x.st.account_id, x.lines.map((l) => l.seq)])).toEqual([
			["tw-old", [1, 5]],
			["tw-new", [2, 3]],
			["tw-other", [4]],
		]);
		expect(r.unknown).toEqual([]);
	});

	it("a one-card bill is not split, and keeps its balances", () => {
		const r = statementsFromAnswer(answer(false), [OLD, NEW, OTHER], "gm-1", "bill.pdf", null);
		expect(r.read).toHaveLength(1);
		expect(r.read[0]!.st).toMatchObject({ account_id: "tw-old", opening_balance_minor: 90_000, closing_balance_minor: 170_000, previous_balance_minor: 90_000, statement_balance_minor: 170_000, bill_primary: 1 });
	});
});

describe("a 台新 bill imported before round 2, read again", () => {
	let db: TestDb;
	beforeEach(async () => {
		db = freshDb();
		await addAccounts(db, [OLD, NEW, OTHER]);
		db.raw.prepare("UPDATE accounts SET replaced_by = 'tw-new' WHERE id = 'tw-old'").run();
	});
	afterEach(() => db.close());
	const linesOn = (acc: string) => (db.raw.prepare("SELECT merchant_raw FROM lines WHERE account_id = ? ORDER BY merchant_raw").all(acc) as { merchant_raw: string }[]).map((x) => x.merchant_raw);

	it("the look back queues it once (capped), one model call reads it, its lines move to their cards", async () => {
		const g = new FakeGmail();
		g.add(mail({ id: "gm-1", from: "台新 <estatement@taishinbank.com.tw>", subject: "信用卡帳單", pdfs: [{ filename: "bill.pdf", attachment_id: "att1", size: PDF.length }] }));
		g.attachments.set("gm-1/att1", PDF);
		const env = makeEnv(db, { ...MODELS, LEDGER_PDF_PW_TAISHIN: PW, LEDGER_CATCHUP_APPROVED_USD: "10" });
		const deps = makeDeps("2026-10-09T05:00:00.000Z");
		db.raw.prepare("INSERT INTO work (gmail_id, source, stage, attempts, created_at, updated_at) VALUES ('gm-1', 'daily', 'new', 0, 'x', 'x')").run();
		// The first reading, as before round 2: everything on the old card, no bill group.
		await runTick(env, deps, { gmail: g, claude: new FakeClaude(() => answer(false)) }, [workQueue]);
		db.raw.prepare("UPDATE statements SET bill_group = NULL, previous_balance_minor = NULL, statement_balance_minor = NULL").run();
		expect(linesOn(OLD.id)).toHaveLength(5);

		deps.advance(60_000);
		const lb = await runTick(env, deps, {}, [lookBack]);
		expect(lb.counts.look_back_reread_queued).toBe(1);
		expect(REREAD_MAX).toBeLessThanOrEqual(40);
		expect(db.raw.prepare("SELECT stage, payload_json FROM work").get()).toEqual({ stage: "new", payload_json: '{"reread":true}' });

		deps.advance(60_000);
		const claude = new FakeClaude(() => answer(true));
		const r = await runTick(env, deps, { gmail: g, claude }, [workQueue]);
		expect(claude.calls).toHaveLength(1);
		expect(claude.calls[0]!.model).toBe("claude-sonnet-5-5"); // the daily reader, never the senior one
		expect(r.counts.reread_lines_moved).toBe(3);
		expect(linesOn(OLD.id)).toEqual(["BAKERY TW", "PAYMENT RECEIVED"]);
		expect(linesOn(NEW.id)).toEqual(["BOOK STORE", "NIGHT MARKET"]);
		expect(linesOn(OTHER.id)).toEqual(["TEA HOUSE"]);
		expect(db.raw.prepare("SELECT account_id, bill_primary, bill_check, recon_status FROM statements ORDER BY account_id").all()).toEqual([
			{ account_id: "tw-new", bill_primary: 0, bill_check: null, recon_status: "reconciled" },
			{ account_id: "tw-old", bill_primary: 1, bill_check: "ok", recon_status: "reconciled" },
			{ account_id: "tw-other", bill_primary: 0, bill_check: null, recon_status: "reconciled" },
		]);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM lines").get()).toEqual({ n: 5 });

		// Done once: the look back never sends it again.
		deps.advance(86_400_000);
		const again = await runTick(env, deps, {}, [lookBack]);
		expect(again.counts.look_back_reread_queued ?? 0).toBe(0);
		expect(db.raw.prepare("SELECT stage FROM work").get()).toEqual({ stage: "done" });
	});
});

// ------------------------------------------------------------------------------------------------
// 14 Oct 2026: live, 台新 card 5506 had no lines at all — every line sat on 5510. Nothing
// stored keeps a printed line's card (the work row keeps the pieces after the split, a statement line
// only its position), so the reading itself must carry it: the reader is told the cards and the
// layout, a section per card heading is folded into the bill, card digits are read however printed,
// and the look back reads every 台新 bill that never split once more. MADE-UP cards and amounts.

/// The bill as a reader may report it: one section per card heading, the balance printed once (on 5510's).
const perHeading = (): StatementAnswer => ({
	institution: "taishin",
	statements: [
		{
			last4: "XXXX-XXXX-XXXX-5510", period_start: "2026-08-14", period_end: "2026-09-13", currency: "TWD",
			opening_balance: "1,000", opening_is_credit: false, closing_balance: "1,500", closing_is_credit: false,
			minimum_due: "150", due_date: "2026-10-01", payments_credited: "1,000",
			lines: [L(1, "2026-08-20", "1,000", "PAYMENT RECEIVED", null, "in", "payment"), L(2, "2026-08-25", "700", "TEA HOUSE", null)],
		},
		{
			last4: "5506", period_start: "2026-08-14", period_end: "2026-09-13", currency: "TWD",
			opening_balance: null, opening_is_credit: false, closing_balance: null, closing_is_credit: false,
			minimum_due: null, due_date: null, payments_credited: null,
			lines: [L(1, "2026-08-21", "300", "NIGHT MARKET", null), L(2, "2026-09-02", "500", "BOOK STORE", "末四碼 5506")],
		},
	],
	confidence: "sure",
	note: "",
});
/// The same bill read as ONE section, each line naming its card the way the heading prints it.
const oneSection = (): StatementAnswer => {
	const [a] = perHeading().statements;
	return {
		...perHeading(),
		statements: [{ ...a!, last4: "5510", lines: [L(1, "2026-08-20", "1,000", "PAYMENT RECEIVED", null, "in", "payment"), L(2, "2026-08-21", "300", "NIGHT MARKET", "XXXX-XXXX-XXXX-5506"), L(3, "2026-08-25", "700", "TEA HOUSE", "5510"), L(4, "2026-09-02", "500", "BOOK STORE", "*506")] }],
	};
};
const CARDS = [OLD, NEW, OTHER];
const pieces = (r: ReturnType<typeof statementsFromAnswer>) => r.read.map((x) => [x.st.account_id, x.st.bill_primary, x.st.printed_net_minor, x.lines.map((l) => l.merchant_raw)]);

describe("a combined 台新 bill: every line reaches the card it was charged on", () => {
	it("a section per card heading folds into the one bill, then splits per card (the balance checked against every card's lines)", () => {
		const folded = foldOneBill(perHeading());
		expect(folded.statements).toHaveLength(1);
		expect(folded.statements[0]!.lines.map((l) => [l.seq, l.card_last4])).toEqual([[1, null], [2, null], [3, "5506"], [4, "末四碼 5506"]]);
		const r = statementsFromAnswer(perHeading(), CARDS, "gm-9", "bill.pdf", null);
		// 1,000 − 1,000 + 700 + 300 + 500 = 1,500: adds up only with 5506's lines in.
		expect(r.adds_up).toBe(true);
		expect(r.unknown).toEqual([]);
		expect(pieces(r)).toEqual([
			["tw-other", 1, -100_000 + 70_000, ["PAYMENT RECEIVED", "TEA HOUSE"]],
			["tw-new", 0, 80_000, ["NIGHT MARKET", "BOOK STORE"]],
		]);
		expect(r.read[0]!.st).toMatchObject({ previous_balance_minor: 100_000, statement_balance_minor: 150_000, minimum_due_minor: 15_000, due_date: "2026-10-01" });
	});

	it("reads card digits however they are printed: masked, with words, or partly hidden", () => {
		const r = statementsFromAnswer(oneSection(), CARDS, "gm-9", "bill.pdf", null);
		expect(r.adds_up).toBe(true);
		expect(pieces(r)).toEqual([
			["tw-other", 1, -30_000, ["PAYMENT RECEIVED", "TEA HOUSE"]],
			["tw-new", 0, 80_000, ["NIGHT MARKET", "BOOK STORE"]],
		]);
	});

	it("a card the ledger does not know: its line stays on the bill's card, and the owner is told its last 4", () => {
		const a = oneSection();
		a.statements[0]!.lines[1] = { ...a.statements[0]!.lines[1]!, card_last4: "5555" };
		const r = statementsFromAnswer(a, CARDS, "gm-9", "bill.pdf", null);
		expect(r.unknown).toEqual(["5555"]);
		expect(r.adds_up).toBe(true); // the figures still add up; only the card is unknown
		expect(pieces(r)[0]![3]).toContain("NIGHT MARKET");
	});

	it("tells the reader which cards the owner holds at a one-bill bank, the lost one with its successor", () => {
		const note = oneBillNote([{ ...OLD, replaced_by: NEW.id }, NEW, OTHER], "taishin");
		expect(note).toContain("end in 5506, 5510");
		expect(note).toContain("5504 (replaced by 5506)");
		expect(note).toContain("ONE section");
		expect(oneBillNote(CARDS, "dbs")).toBe("");
	});
});

describe("a combined 台新 bill, read and imported", () => {
	let db: TestDb;
	beforeEach(async () => {
		db = freshDb();
		await addAccounts(db, CARDS);
		db.raw.prepare("UPDATE accounts SET replaced_by = 'tw-new' WHERE id = 'tw-old'").run();
	});
	afterEach(() => db.close());
	const linesOn = (acc: string) => (db.raw.prepare("SELECT merchant_raw FROM lines WHERE account_id = ? ORDER BY merchant_raw").all(acc) as { merchant_raw: string }[]).map((x) => x.merchant_raw);
	const setup = () => {
		const g = new FakeGmail();
		g.add(mail({ id: "gm-9", from: "台新 <estatement@taishinbank.com.tw>", subject: "信用卡帳單", pdfs: [{ filename: "bill.pdf", attachment_id: "att1", size: PDF.length }] }));
		g.attachments.set("gm-9/att1", PDF);
		const env = makeEnv(db, { ...MODELS, LEDGER_PDF_PW_TAISHIN: PW, LEDGER_CATCHUP_APPROVED_USD: "10" });
		const deps = makeDeps("2026-10-09T05:00:00.000Z");
		db.raw.prepare("INSERT INTO work (gmail_id, source, stage, attempts, created_at, updated_at) VALUES ('gm-9', 'daily', 'new', 0, 'x', 'x')").run();
		return { g, env, deps };
	};

	it("sections for 5510 and 5506 → lines on each card; each card's statement reconciles; the reader was told the cards", async () => {
		const { g, env, deps } = setup();
		const claude = new FakeClaude(() => perHeading());
		await runTick(env, deps, { gmail: g, claude }, [workQueue]);
		expect(claude.calls[0]!.user).toContain("Ledger note: the owner's cards at this bank end in 5506, 5510");
		expect(linesOn(OTHER.id)).toEqual(["PAYMENT RECEIVED", "TEA HOUSE"]);
		expect(linesOn(NEW.id)).toEqual(["BOOK STORE", "NIGHT MARKET"]);
		expect(db.raw.prepare("SELECT account_id, bill_primary, printed_net_minor, bill_check, recon_status FROM statements ORDER BY account_id").all()).toEqual([
			{ account_id: "tw-new", bill_primary: 0, printed_net_minor: 80_000, bill_check: null, recon_status: "reconciled" },
			{ account_id: "tw-other", bill_primary: 1, printed_net_minor: -30_000, bill_check: "ok", recon_status: "reconciled" },
		]);
	});

	it("a bill imported with everything on 5510 is read once more by the look back (v5, once) and 5506's lines move", async () => {
		const { g, env, deps } = setup();
		// The live state: read before this fix, no card on any line — one statement, all on 5510.
		const flat = oneSection();
		flat.statements[0]!.lines = flat.statements[0]!.lines.map((l) => ({ ...l, card_last4: null }));
		await runTick(env, deps, { gmail: g, claude: new FakeClaude(() => flat) }, [workQueue]);
		expect(linesOn(OTHER.id)).toHaveLength(4);
		expect(linesOn(NEW.id)).toEqual([]);
		// A ledger that finished the v4 look back.
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('look_back', ?, 'x') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ version: 4, piece: "done", cursor: null, changed: 0 }));

		deps.advance(60_000);
		const lb = await runTick(env, deps, {}, [lookBack]);
		expect(lb.counts.look_back_resplit_queued).toBe(1);
		expect(db.raw.prepare("SELECT stage, payload_json FROM work").get()).toEqual({ stage: "new", payload_json: '{"reread":true}' });

		deps.advance(60_000);
		const claude = new FakeClaude(() => perHeading());
		const r = await runTick(env, deps, { gmail: g, claude }, [workQueue]);
		expect(claude.calls).toHaveLength(1);
		expect(r.counts.reread_lines_moved).toBe(2);
		expect(linesOn(OTHER.id)).toEqual(["PAYMENT RECEIVED", "TEA HOUSE"]);
		expect(linesOn(NEW.id)).toEqual(["BOOK STORE", "NIGHT MARKET"]);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM lines").get()).toEqual({ n: 4 });
		expect(db.raw.prepare("SELECT account_id, recon_status FROM statements ORDER BY account_id").all()).toEqual([
			{ account_id: "tw-new", recon_status: "reconciled" },
			{ account_id: "tw-other", recon_status: "reconciled" },
		]);

		// Once: the look back is done, and a bill whose lines reached two cards in use is never sent again.
		deps.advance(86_400_000);
		db.raw.prepare("UPDATE sync_state SET value = ? WHERE key = 'look_back'").run(JSON.stringify({ version: 4, piece: "done", cursor: null, changed: 0 }));
		const again = await runTick(env, deps, {}, [lookBack]);
		expect(again.counts.look_back_resplit_queued ?? 0).toBe(0);
		expect(db.raw.prepare("SELECT stage FROM work").get()).toEqual({ stage: "done" });
	});
});

describe("the look back's resplit picks the bills whose lines sit on at most one card in use", () => {
	let db: TestDb;
	beforeEach(async () => {
		db = freshDb();
		await addAccounts(db, CARDS);
		db.raw.prepare("UPDATE accounts SET replaced_by = 'tw-new' WHERE id = 'tw-old'").run();
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('look_back', ?, 'x')").run(JSON.stringify({ version: 4, piece: "done", cursor: null, changed: 0 }));
	});
	afterEach(() => db.close());
	const bill = async (mailId: string, end: string, linesOn: Record<string, number>) => {
		db.raw.prepare("INSERT INTO work (gmail_id, source, kind, stage, attempts, created_at, updated_at) VALUES (?, 'daily', 'statement', 'done', 0, 'x', 'x')").run(mailId);
		db.raw.prepare("INSERT INTO messages (gmail_id, from_addr, subject, received_at, classification, processed_at) VALUES (?, 'estatement@taishinbank.com.tw', 'bill', 'x', 'statement', 'x')").run(mailId);
		for (const [acc, n] of Object.entries(linesOn)) {
			const sid = `${mailId}-${acc}`;
			db.raw.prepare("INSERT INTO statements (id, account_id, period_start, period_end, currency, message_id, attachment_name, recon_status, created_at) VALUES (?, ?, '2026-01-01', ?, 'TWD', ?, 'bill.pdf', 'reconciled', 'x')").run(sid, acc, end, mailId);
			for (let i = 0; i < n; i++) await put(db, "lines", line({ id: `${sid}-${i}`, account_id: acc, txn_date: end, statement_id: sid }));
		}
	};
	it("all on one card, or on one card plus the lost one: read again; on two cards in use: left alone", async () => {
		await bill("gm-a", "2026-09-13", { "tw-other": 3 }); // never split
		await bill("gm-b", "2026-08-13", { "tw-other": 2, "tw-new": 0, "tw-old": 2 }); // split onto the lost card only
		await bill("gm-c", "2026-07-13", { "tw-other": 2, "tw-new": 1 }); // split as it should
		const r = await runTick(makeEnv(db, MODELS), makeDeps("2026-10-15T05:00:00.000Z"), {}, [lookBack]);
		expect(r.counts.look_back_resplit_queued).toBe(2);
		expect(db.raw.prepare("SELECT gmail_id, stage FROM work ORDER BY gmail_id").all()).toEqual([
			{ gmail_id: "gm-a", stage: "new" },
			{ gmail_id: "gm-b", stage: "new" },
			{ gmail_id: "gm-c", stage: "done" },
		]);
	});
});
