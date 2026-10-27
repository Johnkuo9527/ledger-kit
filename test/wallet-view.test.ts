/// How the owner SEES his prepaid wallets (19 Oct 2026). His words: "The
/// accounts list shows GrabPay and 範例 but not Sample Bistro… I can't see any
/// wallet's balance… if the account shows 0 spent, where do I see that I spent
/// this money? It looks like it never exists."
///
/// Presentation and API shape only: every total stays exactly as it was. The
/// three wallets are the made-up ones in test/helpers/fixtures.ts, set up the
/// way the owner's live ones are (CONTRACT §15.3):
///   GrabPay      opening 42.00, all pre-counted; a 5.44 drink → balance 36.56
///   範例          opening 288.88 credit that cost 247.61, pre-counted; 31.40 credit
///                → S$26.91 real cost (offset −26.91) → balance 257.48
///   Sample Bistro  S$200 on the Citi card → 240 credit; a 15.74 meal → S$13.12
///                → balance 224.26
/// Every expected figure was worked by hand in the comments first.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../src/db";
import { addCash, ingestEvidence, markWalletTopUp, type Engine, type EvidenceIn } from "../src/engine";
import { accountViews, coverageFor, lineViews, loadAccountMap, overview, walletDetail, walletDetails } from "../src/queries";
import type { Account, LineRow } from "../src/types";
import { totals } from "../src/views";
import { remainingValue, walkLots } from "../src/wallet";
import { BANK, CARD_A, CARD_C, PREPAID, WALLET, DEMO } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, testEngine, WORLD_ACCOUNTS } from "./helpers/world";

let db: TestDb;
let e: Engine;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db, WORLD_ACCOUNTS);
	for (const a of [WALLET, PREPAID, DEMO]) await insertRow(db, "accounts", a).run();
	e = testEngine(db);
});
afterEach(() => db.close());

let fp = 0;
const alert = (account: Account, merchant: string, amount: number, date: string): EvidenceIn => ({
	type: "alert",
	institution: account.institution,
	last4: account.last4,
	authenticated: true,
	fingerprint: `view-${++fp}`,
	txn_date: date,
	currency: "SGD",
	amount_minor: amount,
	merchant_raw: merchant,
	kind_hint: "purchase",
});
const all = async () => (await db.prepare("SELECT * FROM lines WHERE state <> 'void' ORDER BY created_at, id").bind().all<LineRow>()).results;
const spend = (w: Account, credit: number, date: string, merchant: string, category: string) =>
	addCash(e, { account_id: w.id, txn_date: date, currency: "SGD", amount_minor: credit, merchant, category });

/// A made-up October: three wallets on 19–20 Oct.
async function ownersOctober() {
	await spend(WALLET, 544, "2026-10-14", "drink", "Drinks");
	await spend(DEMO, 3140, "2026-10-18", "範例麵館", "Food");
	const top = (await ingestEvidence(e, alert(CARD_C, "SAMPLE BISTRO         SINGAPORE", 20000, "2026-10-19"))) as { line_id: string };
	await markWalletTopUp(e, top.line_id, PREPAID.id, 24000);
	await spend(PREPAID, 1574, "2026-10-19", "Sample Bistro", "Food");
	return top.line_id;
}

describe("帳戶: every active wallet is always listed", () => {
	it("a wallet holding only a top-up (no spending this month) is still in by_account, at S$0.00 — the totals do not move", async () => {
		const top = (await ingestEvidence(e, alert(CARD_C, "SAMPLE BISTRO SINGAPORE", 20000, "2026-10-19"))) as { line_id: string };
		await markWalletTopUp(e, top.line_id, PREPAID.id, 24000);
		const o = await overview(db, "2026-10", "2026-10-20");
		// Before the fix, by_account came only from spending lines: a top-up is a transfer, so Sample Bistro vanished.
		const ids = o.by_account.map((g) => g.account_id);
		expect(ids).toEqual(expect.arrayContaining([WALLET.id, PREPAID.id, DEMO.id]));
		expect(o.by_account.find((g) => g.account_id === PREPAID.id)).toMatchObject({ kind: "wallet", spending_home: { minor: 0 }, count: 0 });
		expect(o.totals.spending_home.minor).toBe(0);
		expect(o.by_account.reduce((s, g) => s + g.spending_home.minor, 0)).toBe(o.totals.spending_home.minor);
	});

	it("an inactive wallet is not listed; a card with no spending is still left out as before", async () => {
		await db.prepare("UPDATE accounts SET active = 0 WHERE id = ?").bind(DEMO.id).run();
		const ids = (await overview(db, "2026-10", "2026-10-20")).by_account.map((g) => g.account_id);
		expect(ids).not.toContain(DEMO.id);
		expect(ids).not.toContain(CARD_A.id);
	});

	it("The owner's October: all three wallets listed; Sample Bistro S$13.12, GrabPay and 範例 S$0.00 (their meals were paid with pre-counted money); total S$13.12", async () => {
		await ownersOctober();
		const o = await overview(db, "2026-10", "2026-10-20");
		const by = Object.fromEntries(o.by_account.map((g) => [g.account_id, g.spending_home.minor]));
		expect(by).toMatchObject({ [PREPAID.id]: 1312, [WALLET.id]: 0, [DEMO.id]: 0 });
		expect(o.totals.spending_home.minor).toBe(1312);
		expect(totals(await all()).spending_home.minor).toBe(1312);
	});
});

describe("what the credit left is worth (pure)", () => {
	const top = (id: string, credit: number, paid: number, date: string, at: string) => ({ id, kind: "transfer" as const, state: "open" as const, txn_date: date, created_at: at, bill_minor: -credit, home_minor: -paid, merged_into: null });
	const use = (id: string, credit: number, date: string, at: string) => ({ id, kind: "purchase" as const, state: "open" as const, txn_date: date, created_at: at, bill_minor: credit, home_minor: credit, merged_into: null });

	it("240 credit for S$200, 15.74 used (cost round(200 × 15.74 / 240) = 13.12): 224.26 left is worth 200.00 − 13.12 = S$186.88", () => {
		expect(remainingValue(0, null, "2026-10-19", [top("t", 24000, 20000, "2026-10-19", "a"), use("m", 1574, "2026-10-19", "b")])).toBe(18688);
	});

	it("範例's opening lot: 288.88 credit that cost 247.61; 31.40 used costs round(247.61 × 31.40 / 288.88) = 26.91 → 220.70 left", () => {
		// 24761 × 3140 = 77,749,540; ÷ 28888 = 2691.41 → 2691. 24761 − 2691 = 22070.
		expect(remainingValue(28888, 24761, "2026-10-18", [use("m", 3140, "2026-10-18", "a")])).toBe(22070);
	});

	it("two lots, oldest first: 250 credit used of 240-for-200 then 110-for-100 → the first is spent, the second has 100 credit worth 100.00 − round(100 × 10/110) = S$90.91", () => {
		// lot 2: 10.00 credit used → round(10000 × 1000 / 11000) = 909; 10000 − 909 = 9091.
		const lines = [top("t1", 24000, 20000, "2026-10-19", "a"), top("t2", 11000, 10000, "2026-10-20", "b"), use("m", 25000, "2026-10-21", "c")];
		expect(remainingValue(0, null, "2026-10-19", lines)).toBe(9091);
		const { lots } = walkLots(0, null, "2026-10-19", lines);
		expect(lots.map((l) => [l.line_id, l.used])).toEqual([["t1", 24000], ["t2", 1000]]);
	});

	it("no bonus (GrabPay): the value left IS the balance; a used-up lot leaves exactly 0, and credit used beyond every lot leaves nothing", () => {
		expect(remainingValue(4200, null, "2026-10-14", [use("m", 544, "2026-10-14", "a")])).toBe(3656);
		// round-tripping a lot: 100 + 100 + 40 of 240-for-200 → 83.33 + 83.34 + 33.33 = 200.00, nothing left
		const lot = [top("t", 24000, 20000, "2026-10-19", "a"), use("a", 10000, "2026-10-20", "b"), use("b", 10000, "2026-10-20", "c"), use("c", 4000, "2026-10-20", "d")];
		expect(remainingValue(0, null, "2026-10-19", lot)).toBe(0);
		expect(remainingValue(1000, null, "2026-10-19", [use("m", 1500, "2026-10-19", "a")])).toBe(0);
	});
});

describe("each wallet's balance AND its real value, wherever the page reads wallets", () => {
	it("coverage and the account list carry remaining_value next to the credit balance", async () => {
		await ownersOctober();
		const accounts = await loadAccountMap(db);
		const cov = await coverageFor(db, accounts.values(), "2026-10-20");
		const w = (id: string) => cov.find((c) => c.account_id === id)!.wallet!;
		expect([w(PREPAID.id).balance.minor, w(PREPAID.id).remaining_value.minor, w(PREPAID.id).precounted_left.minor]).toEqual([22426, 18688, 0]);
		// 範例: 288.88 − 31.40 = 257.48 credit; worth 220.70; all of it pre-counted (247.61 − 26.91 = 220.70).
		expect([w(DEMO.id).balance.minor, w(DEMO.id).remaining_value.minor, w(DEMO.id).precounted_left.minor]).toEqual([25748, 22070, 22070]);
		expect([w(WALLET.id).balance.minor, w(WALLET.id).remaining_value.minor, w(WALLET.id).precounted_left.minor]).toEqual([3656, 3656, 3656]);
		// The overview tile: 186.88 + 220.70 + 36.56 = S$444.14 prepaid and not used, of which 220.70 + 36.56 = 257.26 pre-counted.
		const views = (await accountViews(db)).filter((a) => a.wallet);
		expect(views.reduce((s, a) => s + a.wallet!.remaining_value.minor, 0)).toBe(44414);
		expect(views.reduce((s, a) => s + a.wallet!.precounted_left.minor, 0)).toBe(25726);
	});
});

describe("明細: a top-up is ONE line in the list (both legs keep their data)", () => {
	it("both legs carry the pair: the Citi leg is the one shown (role source), the wallet leg folds into it (role wallet)", async () => {
		const citiId = await ownersOctober();
		const rows = await all();
		const views = await lineViews(db, rows);
		const citi = views.find((v) => v.id === citiId)!;
		const leg = views.find((v) => v.account.id === PREPAID.id && v.kind === "transfer")!;
		expect(citi).toMatchObject({ kind: "transfer", spending: false, amount: { home: { minor: 20000 } } });
		expect(citi.topup).toMatchObject({ role: "source", wallet: { id: PREPAID.id }, from: { id: CARD_C.id }, source_line_id: citiId, wallet_line_id: leg.id, paid: { minor: 20000 }, credit: "240.00", title: `儲值 ${PREPAID.name}` });
		expect(citi.topup!.message).toBe("$200.00 → 儲值金 240.00（預付，用掉時才算支出）");
		expect(leg.topup).toMatchObject({ role: "wallet", source_line_id: citiId, wallet_line_id: leg.id });
		// Data unchanged: still two transfer lines, neither is spending, totals as before.
		expect(rows.filter((l) => l.transfer_group === citi.transfer_group).map((l) => [l.kind, l.bill_minor, l.home_minor]).sort()).toEqual([
			["transfer", -24000, -20000],
			["transfer", 20000, 20000],
		]);
		// Every other line has none; the offset still points at its meal for the page to fold.
		expect(views.filter((v) => v.topup).length).toBe(2);
		const offset = views.find((v) => v.kind === "wallet_offset" && v.account.id === DEMO.id)!;
		const meal = views.find((v) => v.wallet?.offset_line_id === offset.id && v.kind === "purchase")!;
		expect(offset.wallet!.offset_of).toBe(meal.id);
		expect(meal.amount.home.minor).toBe(2691);
	});

	it("a top-up without a bonus reads without the credit: 「S$20.00（預付，用掉時才算支出）」", async () => {
		const bank = (await ingestEvidence(e, alert(BANK, "GRAB", 2000, "2026-10-15"))) as { line_id: string };
		const v = (await lineViews(db, await all())).find((x) => x.id === bank.line_id)!;
		expect(v.topup).toMatchObject({ role: "source", wallet: { id: WALLET.id }, credit: "20.00" });
		expect(v.topup!.message).toBe("$20.00（預付，用掉時才算支出）");
	});
});

describe("one wallet, as the owner reads it when he taps it", () => {
	it("Sample Bistro: balance 224.26 ≈ S$186.88; the Citi top-up as a lot (200 → 240, 15.74 used, 224.26 left); the meal at 15.74 credit / S$13.12 Food", async () => {
		await ownersOctober();
		const d = (await walletDetail(db, PREPAID.id))!;
		expect(d).toMatchObject({ balance: { minor: 22426 }, remaining_value: { minor: 18688 }, precounted_left: { minor: 0 }, bonus: true, uses_count: 1 });
		expect(d.lots).toEqual([
			expect.objectContaining({ kind: "topup", date: "2026-10-19", from: { id: CARD_C.id, name: CARD_C.name }, paid: expect.objectContaining({ minor: 20000 }), credit: "240.00", used: "15.74", left: "224.26", value_left: expect.objectContaining({ minor: 18688 }), precounted: false }),
		]);
		expect(d.uses).toEqual([expect.objectContaining({ date: "2026-10-19", category: "Food", credit: "15.74", cost: expect.objectContaining({ minor: 1312 }), precounted: null })]);
		expect(d.used).toMatchObject({ credit: "15.74", cost: { minor: 1312 }, precounted: { minor: 0 }, counted_now: { minor: 1312 } });
		expect(d.story[0]).toBe("餘額 224.26（店家的儲值金），約值 $186.88：已預付、還沒用掉的錢，用掉時才算支出。");
		expect(d.precounted_topups).toEqual([]);
	});

	it("範例: its old card top-ups (whole dollars at the shop, before the cut-over) are named — 「這筆儲值在 3月2日、4月30日 刷卡時已經算過支出」 — and the meal shows its pre-counted part", async () => {
		await ingestEvidence(e, alert(CARD_A, "DEMO NOODLE HOUSE SINGAPORE SG", 30000, "2026-03-02"));
		await ingestEvidence(e, alert(CARD_A, "DEMO NOODLE HOUSE SINGAPORE SG", 4530, "2026-08-10")); // a meal paid by card: not a top-up
		await ingestEvidence(e, alert(CARD_A, "DEMO NOODLE HOUSE SINGAPORE SG", 30000, "2026-04-30"));
		await ingestEvidence(e, alert(CARD_A, "SOME OTHER SHOP", 30000, "2026-09-01"));
		await ownersOctober();
		const d = (await walletDetail(db, DEMO.id))!;
		expect(d.precounted_topups.map((h) => [h.date, h.account, h.paid.minor])).toEqual([
			["2026-04-30", CARD_A.name, 30000],
			["2026-03-02", CARD_A.name, 30000],
		]);
		expect(d.story.join("")).toContain("這筆儲值在 3月2日、4月30日 刷卡時已經算過支出");
		expect(d.lots).toEqual([expect.objectContaining({ kind: "opening", date: "2026-10-18", credit: "288.88", used: "31.40", left: "257.48", paid: expect.objectContaining({ minor: 24761 }), value_left: expect.objectContaining({ minor: 22070 }), precounted: true })]);
		expect(d.uses).toEqual([expect.objectContaining({ credit: "31.40", cost: expect.objectContaining({ minor: 2691 }), precounted: expect.objectContaining({ minor: 2691 }) })]);
		// Spent from it: S$26.91 real cost, all of it pre-counted → S$0.00 counted this month. Explained, not missing.
		expect(d.used).toMatchObject({ cost: { minor: 2691 }, precounted: { minor: 2691 }, counted_now: { minor: 0 } });
	});

	it("GrabPay with no old top-up on file says so by date; every active wallet comes back from walletDetails; a card is not a wallet", async () => {
		await ownersOctober();
		const d = (await walletDetail(db, WALLET.id))!;
		expect(d.story.join("")).toContain("2026-10-14 以前的儲值，當時刷卡已經算過支出");
		expect(d).toMatchObject({ balance: { minor: 3656 }, remaining_value: { minor: 3656 }, bonus: false });
		expect((await walletDetails(db)).map((w) => w.account.id).sort()).toEqual([WALLET.id, PREPAID.id, DEMO.id].sort());
		expect(await walletDetail(db, CARD_C.id)).toBeNull();
		expect(await walletDetail(db, "no-such")).toBeNull();
	});
});
