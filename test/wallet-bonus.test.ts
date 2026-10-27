/// Prepaid bonus credit and a shop's SMS (19 Oct 2026). End to end on
/// the real migrations.
///
/// The owner: "I paid S$200 and got 240 in credit." The card's balance shows the
/// SHOP'S credit (240, as on its site); each meal takes credit at face value,
/// but the ledger records its real cost = credit × paid ÷ credit got
/// (24 credit → S$20.00). Every top-up is its own lot; meals use the oldest lot
/// first; a lot's meals add up to exactly what was paid for it.
///
/// And the made-up 範例 card (test/helpers/fixtures.ts DEMO): the
/// shop texts after each use; the SMS is read (a sample in RestoSuite's format), the meal is
/// recorded at real cost — offset, since that credit was counted as spending at
/// its card top-ups — and the balance it states is checked.
///
/// Every expected figure was worked by hand in the comments first.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../src/db";
import { addCash, getLine, ingestEvidence, markWalletTopUp, setTopUpCredit, type Engine, type EvidenceIn } from "../src/engine";
import { accountViews, lineViews, needsOk } from "../src/queries";
import type { LineRow } from "../src/types";
import { totals } from "../src/views";
import { planCosts, smsWallet, type WalletAccount } from "../src/wallet";
import { answerSmsCheck, applySmsReading, parseSmsLocally, smsRow } from "../src/wallet-sms";
import { BANK, CARD_A, CARD_C, PREPAID, WALLET, DEMO, DEMO_SMS } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, testEngine, WORLD_ACCOUNTS } from "./helpers/world";

let db: TestDb;
let e: Engine;
const P = PREPAID as WalletAccount;
const G = WALLET as WalletAccount;
const X = DEMO as WalletAccount;

beforeEach(async () => {
	db = freshDb();
	await addAccounts(db, WORLD_ACCOUNTS);
	for (const a of [WALLET, PREPAID, DEMO]) await insertRow(db, "accounts", a).run();
	e = testEngine(db);
});
afterEach(() => db.close());

const all = async () => (await db.prepare("SELECT * FROM lines WHERE state <> 'void' ORDER BY created_at, id").bind().all<LineRow>()).results;
const spending = async () => totals(await all()).spending_home.minor;
const balance = async (id: string) => (await accountViews(db)).find((a) => a.id === id)!.wallet!.balance.minor;
let fp = 0;
const cardAlert = (merchant: string, amount: number, date: string, account = CARD_C): EvidenceIn => ({
	type: "alert",
	institution: account.institution,
	last4: account.last4,
	authenticated: true,
	fingerprint: `bonus-${++fp}`,
	txn_date: date,
	currency: "SGD",
	amount_minor: amount,
	merchant_raw: merchant,
	kind_hint: "purchase",
});
const idOf = (r: unknown) => (r as { line_id: string }).line_id;
const HG = "SAMPLE BISTRO         SINGAPORE";
const meal = (w: WalletAccount, credit: number, date: string) => addCash(e, { account_id: w.id, txn_date: date, currency: "SGD", amount_minor: credit, merchant: "meal", category: "Food" });

describe("the cost of credit, first in first out (pure)", () => {
	it("240 credit for S$200: a 24-credit meal costs S$20.00, and ten of them cost exactly S$200.00", () => {
		const lines = [{ id: "top", kind: "transfer" as const, state: "open" as const, txn_date: "2026-10-19", created_at: "a", bill_minor: -24000, home_minor: -20000, merged_into: null }];
		for (let i = 0; i < 10; i++) lines.push({ id: `m${i}`, kind: "purchase" as never, state: "open" as const, txn_date: "2026-10-20", created_at: `b${i}`, bill_minor: 2400, home_minor: 2400, merged_into: null });
		const costs = planCosts(0, null, "2026-10-19", lines);
		expect([...costs.values()]).toEqual(Array(10).fill(2000));
		expect([...costs.values()].reduce((s, c) => s + c, 0)).toBe(20000);
	});

	it("the last use of a lot absorbs the cents: 100 + 100 + 40 credit of 240-for-200 cost 83.33 + 83.34 + 33.33 = 200.00", () => {
		// running totals: round(200 × 100/240) = 83.33; round(200 × 200/240) = 166.67 → 83.34; the lot used up → 200.00 → 33.33
		const top = { id: "top", kind: "transfer" as const, state: "open" as const, txn_date: "2026-10-19", created_at: "a", bill_minor: -24000, home_minor: -20000, merged_into: null };
		const m = (id: string, credit: number, at: string) => ({ id, kind: "purchase" as const, state: "open" as const, txn_date: "2026-10-20", created_at: at, bill_minor: credit, home_minor: credit, merged_into: null });
		const costs = planCosts(0, null, "2026-10-19", [top, m("a", 10000, "b1"), m("b", 10000, "b2"), m("c", 4000, "b3")]);
		expect(Object.fromEntries(costs)).toEqual({ a: 8333, b: 8334, c: 3333 });
	});

	it("no bonus anywhere (GrabPay): every cost is its credit; credit used beyond every lot is face value", () => {
		const lines = [
			{ id: "top", kind: "transfer" as const, state: "open" as const, txn_date: "2026-10-14", created_at: "a", bill_minor: -2000, home_minor: -2000, merged_into: null },
			{ id: "x", kind: "purchase" as const, state: "open" as const, txn_date: "2026-10-15", created_at: "b", bill_minor: 1234, home_minor: 1234, merged_into: null },
			{ id: "y", kind: "purchase" as const, state: "open" as const, txn_date: "2026-10-16", created_at: "c", bill_minor: 9999, home_minor: 9999, merged_into: null },
		];
		expect(Object.fromEntries(planCosts(4200, null, "2026-10-14", lines))).toEqual({ x: 1234, y: 9999 });
	});
});

describe("The owner's Sample Bistro S$200 → 240 credit", () => {
	it("wallet_topup with credit 240: not spending, balance 240.00 (the shop's figure); a 24.00 meal costs S$20.00 and leaves 216.00", async () => {
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 20000, "2026-10-19"))); // the rule takes it as a top-up at face value…
		await markWalletTopUp(e, id, P.id, 24000); // …and the owner's word gives its credit
		const leg = (await all()).find((l) => l.account_id === P.id)!;
		expect(leg).toMatchObject({ kind: "transfer", bill_minor: -24000, home_minor: -20000 });
		expect(leg.note).toContain("拿到儲值金 240.00");
		expect(await balance(P.id)).toBe(24000);
		expect(await spending()).toBe(0);
		const m = await meal(P, 2400, "2026-10-20");
		expect(m).toMatchObject({ bill_minor: 2400, orig_minor: 2400, home_minor: 2000 });
		expect(await balance(P.id)).toBe(21600);
		expect(await spending()).toBe(2000);
		const [view] = await lineViews(db, [m]);
		expect(view!.amount.original.minor).toBe(2400);
		expect(view!.amount.home.minor).toBe(2000);
		expect(view!.credit).toMatchObject({ used: "24.00", cost: { minor: 2000 } });
		expect(view!.credit!.message).toContain("實際成本");
		// No 「這次儲值有送嗎？」: the owner answered it.
		expect((await needsOk(db)).wallet_topups).toEqual([]);
	});

	it("two lots with different deals, oldest first: 210, 50 and 90 credit cost 175.00, 43.18 and 81.82 — S$300.00 in all", async () => {
		// lot 1: 240 for 200; lot 2: 110 for 100.
		// 210 from lot 1: round(200 × 210/240) = 175.00.
		// 50: 30 from lot 1 (used up → 200.00 − 175.00 = 25.00) + 20 from lot 2 (round(100 × 20/110) = 18.18) = 43.18.
		// 90 from lot 2 (used up → 100.00 − 18.18 = 81.82). 175.00 + 43.18 + 81.82 = 300.00.
		await markWalletTopUp(e, idOf(await ingestEvidence(e, cardAlert(HG, 20000, "2026-10-19"))), P.id, 24000);
		await markWalletTopUp(e, idOf(await ingestEvidence(e, cardAlert(HG, 10000, "2026-10-20"))), P.id, 11000);
		const a = await meal(P, 21000, "2026-10-21");
		const b = await meal(P, 5000, "2026-10-22");
		const c = await meal(P, 9000, "2026-10-23");
		const cost = async (l: LineRow) => (await getLine(db, l.id))!.home_minor;
		expect([await cost(a), await cost(b), await cost(c)]).toEqual([17500, 4318, 8182]);
		expect(await spending()).toBe(30000);
		expect(await balance(P.id)).toBe(0);
	});

	it("credit given after the meals: they are costed again", async () => {
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 20000, "2026-10-19")));
		const m = await meal(P, 2400, "2026-10-20");
		expect(m.home_minor).toBe(2400); // face value while no bonus is known
		await setTopUpCredit(e, id, 24000);
		expect((await getLine(db, m.id))!.home_minor).toBe(2000);
	});

	it("a credit below what was paid, or above twice it, is refused in plain words — nothing changes", async () => {
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 20000, "2026-10-19")));
		await expect(markWalletTopUp(e, id, P.id, 19000)).rejects.toThrow(/比付的錢/);
		await expect(markWalletTopUp(e, id, P.id, 240000)).rejects.toThrow(/打錯字/);
		expect(await balance(P.id)).toBe(20000);
	});
});

describe("an automatic top-up cannot know the bonus: 「這次儲值有送嗎？」", () => {
	it("a round S$100 at the shop is a top-up at face value, with a question on 待確認; the owner's answer (120) re-costs the meal and clears it", async () => {
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 10000, "2026-10-21")));
		expect(await balance(P.id)).toBe(10000);
		const q = (await needsOk(db)).wallet_topups;
		expect(q).toHaveLength(1);
		expect(q[0]!.title).toBe("這次儲值有送嗎？Sample Bistro 儲值卡");
		expect(q[0]!.actions.map((a) => a.id)).toEqual(["credit", "none"]);
		expect(q[0]!.actions[0]).toMatchObject({ input_key: "credit", input_label: "拿到的儲值金額", input_value: "100.00" });
		const m = await meal(P, 2400, "2026-10-22");
		expect(m.home_minor).toBe(2400);
		await setTopUpCredit(e, q[0]!.id, 12000); // round(100 × 24/120) = 20.00
		expect((await getLine(db, m.id))!.home_minor).toBe(2000);
		expect(await balance(P.id)).toBe(12000 - 2400);
		const after = await needsOk(db);
		expect(after.wallet_topups).toEqual([]);
		expect(after.count).toBe(0);
	});

	it("「沒有送」 clears it too, the money unchanged", async () => {
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 10000, "2026-10-21")));
		await setTopUpCredit(e, id, null);
		expect((await needsOk(db)).wallet_topups).toEqual([]);
		expect(await balance(P.id)).toBe(10000);
	});
});

describe("GrabPay is unchanged", () => {
	it("its top-ups and purchases keep cost = amount, and nothing is ever re-costed; no bonus question", async () => {
		await ingestEvidence(e, { ...cardAlert("GRAB", 2000, "2026-10-20", BANK), institution: BANK.institution });
		const a = await meal(G, 1234, "2026-10-20");
		const b = await meal(G, 5000, "2026-10-21");
		for (const l of [a, b]) expect((await getLine(db, l.id))!.home_minor).toBe(l.bill_minor);
		const events = await db.prepare("SELECT COUNT(*) AS n FROM line_events WHERE event IN ('wallet_cost', 'wallet_topup_credit')").bind().first<{ n: number }>();
		expect(events!.n).toBe(0);
		expect((await needsOk(db)).wallet_topups).toEqual([]);
		expect(await balance(G.id)).toBe(4200 + 2000 - 1234 - 5000);
	});
});

// ------------------------------------------------------------- 範例's SMS

let sms = 0;
async function smsIn(text: string, date: string, receivedAt = `${date}T12:00:00.000Z`): Promise<string> {
	const id = `sms-${++sms}`;
	await db
		.prepare("INSERT INTO wallet_sms (id, fingerprint, account_id, sender, text, received_at, sms_date, state, updated_at) VALUES (?, ?, ?, 'RestoSuite', ?, ?, ?, 'reading', ?)")
		.bind(id, `fp-${id}`, X.id, text, receivedAt, date, receivedAt)
		.run();
	return id;
}
const read = async (id: string) => {
	const row = (await smsRow(db, id))!;
	return applySmsReading(e, row, parseSmsLocally(row.text, "SGD")!, "Food");
};

describe("範例's SMS, read by code", () => {
	it("the sample SMS: 31.40 used, 257.48 left — full-width punctuation reads the same; anything else goes to the reading desk", () => {
		expect(parseSmsLocally(DEMO_SMS, "SGD")).toEqual({ kind: "spend", spent_minor: 3140, balance_minor: 25748 });
		expect(parseSmsLocally("【DEMO NOODLE】您的卡*5509在範例麵館 @ 101，消费卡值：＄1,031.40，卡余额：＄257.48", "SGD")).toEqual({ kind: "spend", spent_minor: 103140, balance_minor: 25748 });
		expect(parseSmsLocally("【DEMO NOODLE】感谢您的光临！", "SGD")).toBeNull();
		expect(parseSmsLocally("【DEMO NOODLE】充值: $300.00,卡余额:$557.48", "SGD")).toBeNull(); // a top-up notice: no amount used
		expect(parseSmsLocally("消费卡值: $10.00, 卡余额: $20.00, 卡余额: $30.00", "SGD")).toBeNull(); // two balances: never a guess
	});

	it("only 範例's own SMS reaches it: from RestoSuite AND naming 範例 / DEMO NOODLE", () => {
		const accounts = [...WORLD_ACCOUNTS, WALLET, PREPAID, DEMO];
		expect(smsWallet(accounts, DEMO_SMS, "RestoSuite")?.id).toBe(X.id);
		expect(smsWallet(accounts, DEMO_SMS, "restosuite")?.id).toBe(X.id); // case ignored
		expect(smsWallet(accounts, "【OTHER PLACE】您的卡*1111在别的餐厅,消费卡值: $20.00,卡余额:$80.00", "RestoSuite")).toBeNull(); // RestoSuite for another shop
		expect(smsWallet(accounts, DEMO_SMS, "+6512345678")).toBeNull(); // someone else using its words
		expect(smsWallet(accounts, DEMO_SMS, null)).toBeNull();
		expect(smsWallet(accounts, "SAMPLE BISTRO 消费卡值: $20.00,卡余额:$80.00", "RestoSuite")).toBeNull(); // a wallet without SMS settings never takes one
	});

	it("the sample becomes one meal on 2026-10-18: 31.40 credit, real cost S$26.91, offset (counted at its card top-ups) — balance 257.48 = the SMS's", async () => {
		// cost: round(247.61 × 31.40 ÷ 288.88) = round(26.9141) = 26.91; pre-counted 247.61 covers it all → offset −26.91, spending 0.
		const row = await read(await smsIn(DEMO_SMS, "2026-10-18"));
		expect(row).toMatchObject({ state: "done", spent_minor: 3140, balance_minor: 25748, ledger_balance_minor: 25748, check_state: "ok", text: "" });
		const mine = (await all()).filter((l) => l.account_id === X.id);
		expect(mine.map((l) => [l.kind, l.txn_date, l.bill_minor, l.home_minor, l.category])).toEqual([
			["purchase", "2026-10-18", 3140, 2691, "Food"],
			["wallet_offset", "2026-10-18", -2691, -2691, "Food"],
		]);
		expect(await spending()).toBe(0);
		expect(await balance(X.id)).toBe(25748);
		const view = (await accountViews(db)).find((a) => a.id === X.id)!.wallet!;
		expect(view.precounted_left.minor).toBe(24761 - 2691); // 220.70
		expect(view.topup_deal).toMatchObject({ paid: { minor: 30000 }, credit: { minor: 35000 } });
		expect((await needsOk(db)).count).toBe(0);
	});

	it("the connector call and the SMS for the same meal make ONE line", async () => {
		const told = await meal(X, 3140, "2026-10-18");
		const row = await read(await smsIn(DEMO_SMS, "2026-10-18", "2026-10-20T03:00:00.000Z"));
		expect(row.line_id).toBe(told.id);
		expect((await all()).filter((l) => l.account_id === X.id && l.kind === "purchase")).toHaveLength(1);
		expect(row.check_state).toBe("ok");
	});

	it("a card top-up at the shop gets its deal (S$300 → 350 credit), no question; the next meal uses the old credit first", async () => {
		await read(await smsIn(DEMO_SMS, "2026-10-18"));
		await ingestEvidence(e, cardAlert("DEMO NOODLE HOUSE SINGAPORE SG", 30000, "2026-10-20", CARD_A));
		const leg = (await all()).find((l) => l.account_id === X.id && l.kind === "transfer")!;
		expect(leg).toMatchObject({ bill_minor: -35000, home_minor: -30000 });
		expect(await balance(X.id)).toBe(25748 + 35000);
		expect((await needsOk(db)).wallet_topups).toEqual([]);
		// 300.00 credit on 10-21: 257.48 from the old lot (used up: 247.61 − 26.91 = 220.70) + 42.52 from the new
		// (round(300 × 42.52 ÷ 350) = 36.45) = 257.15; the old part is pre-counted: offset −220.70, so 36.45 counts.
		const m = await meal(X, 30000, "2026-10-21");
		expect((await getLine(db, m.id))!.home_minor).toBe(25715);
		expect(await spending()).toBe(3645);
		expect(await balance(X.id)).toBe(30748);
	});

	it("an SMS balance that differs: 待確認 「範例 儲值卡 簡訊餘額 250.00，帳本算出 257.48」; taking the SMS's balance adds one 7.48 meal line", async () => {
		const id = await smsIn(DEMO_SMS.replace("257.48", "250.00"), "2026-10-18");
		expect(await read(id)).toMatchObject({ check_state: "mismatch", balance_minor: 25000, ledger_balance_minor: 25748 });
		const items = (await needsOk(db)).wallet_sms;
		expect(items).toHaveLength(1);
		expect(items[0]!.title).toBe("範例 儲值卡 簡訊餘額 250.00，帳本算出 257.48");
		expect(items[0]!.actions.map((a) => a.label)).toEqual(["用簡訊的餘額（記一筆調整）", "我自己查"]);
		const r = await answerSmsCheck(e, id, "accept", "Food");
		const adj = (await getLine(db, r.line_id!))!;
		expect(adj).toMatchObject({ kind: "purchase", bill_minor: 748, txn_date: "2026-10-18", category: "Food" });
		expect(await balance(X.id)).toBe(25000);
		expect((await needsOk(db)).wallet_sms).toEqual([]);
		await expect(answerSmsCheck(e, id, "accept", "Food")).rejects.toThrow(/不需要處理/); // twice = once
	});

	it("「我自己查」 leaves the ledger as it is", async () => {
		const id = await smsIn(DEMO_SMS.replace("257.48", "260.00"), "2026-10-18");
		await read(id);
		const before = (await all()).length;
		await answerSmsCheck(e, id, "checked", "Food");
		expect((await all()).length).toBe(before);
		expect((await needsOk(db)).wallet_sms).toEqual([]);
	});
});
