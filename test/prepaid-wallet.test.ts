/// Any prepaid wallet, not just GrabPay (19 Oct 2026): the owner's
/// Sample Bistro stored-value card. End to end on the real migration.
///
/// The owner: "The S$200 I just spent is a top-up — later purchases will be
/// deducted from it, same as Grab." The prepaid card (test/helpers/fixtures.ts
/// PREPAID) is recorded from 2026-10-19 with nothing in it and nothing
/// pre-counted; its top-up rule is data on its row: a card or bank line naming
/// SAMPLE BISTRO for a whole number of dollars. The GrabPay-like wallet
/// (WALLET) sits beside it throughout, to show GrabPay is unchanged.
/// Every expected figure was worked out by hand in the comments first.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../src/db";
import { addCash, getLine, ingestEvidence, markWalletTopUp, setLineKind, setPayeeRule, type Engine, type EvidenceIn } from "../src/engine";
import { merchantKey } from "../src/merchant";
import { accountViews, coverageFor, lineViews, loadAccountMap } from "../src/queries";
import type { LineRow } from "../src/types";
import { totals } from "../src/views";
import { fitsTopUpRule, topUpWallet, type WalletAccount } from "../src/wallet";
import { BANK, CARD_A, CARD_C, CASH, PREPAID, WALLET } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, testEngine, WORLD_ACCOUNTS } from "./helpers/world";

let db: TestDb;
let e: Engine;
const P = PREPAID as WalletAccount;
const G = WALLET as WalletAccount;

beforeEach(async () => {
	db = freshDb();
	await addAccounts(db, WORLD_ACCOUNTS);
	await insertRow(db, "accounts", WALLET).run();
	await insertRow(db, "accounts", PREPAID).run();
	e = testEngine(db);
});
afterEach(() => db.close());

const all = async () => (await db.prepare("SELECT * FROM lines WHERE state <> 'void'").bind().all<LineRow>()).results;
const spending = async () => totals(await all()).spending_home.minor;
const balance = async (id: string) => (await accountViews(db)).find((a) => a.id === id)!.wallet!.balance.minor;
let fp = 0;
/// A card alert on the made-up Citi card (CARD_C), as the owner's S$200 came.
const cardAlert = (merchant: string, amount: number, date: string, account = CARD_C): EvidenceIn => ({
	type: "alert",
	institution: account.institution,
	last4: account.last4,
	authenticated: true,
	fingerprint: `card-${++fp}`,
	txn_date: date,
	currency: "SGD",
	amount_minor: amount,
	merchant_raw: merchant,
	kind_hint: "purchase",
});
const idOf = (r: unknown) => (r as { line_id: string }).line_id;
const HG = "SAMPLE BISTRO         SINGAPORE"; // exactly as the Citi alert printed it

describe("the wallet's own top-up rule, as data", () => {
	it("a whole number of dollars at SAMPLE BISTRO on a card or bank is a top-up of that wallet; anything else is not", () => {
		const card = { kind: "credit_card" as const };
		expect(fitsTopUpRule(card, HG, 20000, "2026-10-19", P)).toBe(true); // S$200.00
		expect(fitsTopUpRule(card, "Sample-Bistro Pte Ltd", 10000, "2026-10-20", P)).toBe(true); // case, dashes and spaces ignored
		expect(fitsTopUpRule({ kind: "bank" }, "SAMPLEBISTRO", 5000, "2026-10-20", P)).toBe(true);
		expect(fitsTopUpRule(card, HG, 2340, "2026-10-20", P)).toBe(false); // S$23.40: a meal paid by card
		expect(fitsTopUpRule(card, HG, 20000, "2026-10-18", P)).toBe(false); // before the wallet's start
		expect(fitsTopUpRule(card, HG, -20000, "2026-10-20", P)).toBe(false); // money back is a refund
		expect(fitsTopUpRule({ kind: "cash" }, HG, 20000, "2026-10-20", P)).toBe(false); // only a bank or card tops it up
		expect(fitsTopUpRule(card, "SAMPLE FLAVOURS", 20000, "2026-10-20", P)).toBe(false);
		// Whole dollars off: any amount counts.
		expect(fitsTopUpRule(card, HG, 2340, "2026-10-20", { ...P, wallet_topup_whole_dollars: 0 })).toBe(true);
		// GrabPay has no data rule: its own, in code.
		expect(fitsTopUpRule(card, "GRAB", 2000, "2026-10-20", G)).toBe(false);
	});

	it("which wallet a line tops up: each by its own rule — and GrabPay's rule unchanged beside it", () => {
		const accounts = [...WORLD_ACCOUNTS, WALLET, PREPAID];
		expect(topUpWallet(accounts, { kind: "credit_card" }, HG, 20000, "2026-10-19")?.id).toBe(P.id);
		expect(topUpWallet(accounts, { kind: "credit_card" }, HG, 2340, "2026-10-19")).toBeNull();
		expect(topUpWallet(accounts, { kind: "bank" }, "GRAB", 2000, "2026-10-19")?.id).toBe(G.id);
		expect(topUpWallet(accounts, { kind: "credit_card" }, "GRAB", 2000, "2026-10-19")).toBeNull(); // a card needs the word top-up, as before
		expect(topUpWallet(accounts, { kind: "credit_card" }, "GRABPAY TOP UP", 3000, "2026-10-19")?.id).toBe(G.id);
		// A wallet no longer in use tops up nothing.
		expect(topUpWallet([...WORLD_ACCOUNTS, WALLET, { ...PREPAID, active: 0 }], { kind: "credit_card" }, HG, 20000, "2026-10-19")).toBeNull();
	});
});

describe("The owner's S$200 at Sample Bistro was a top-up", () => {
	it("by his word: the Citi line, read as spending before the wallet existed, becomes a transfer to the wallet — not spending, balance S$200", async () => {
		// As on his live ledger: the line came in while there was no such wallet.
		await db.prepare("DELETE FROM accounts WHERE id = ?").bind(P.id).run();
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 20000, "2026-10-19")));
		expect(await getLine(db, id)).toMatchObject({ kind: "purchase" });
		expect(await spending()).toBe(20000);
		await insertRow(db, "accounts", PREPAID).run();

		const after = await markWalletTopUp(e, id, P.id);
		expect(after).toMatchObject({ kind: "transfer", counter_account_id: P.id });
		expect(after.transfer_group).not.toBeNull();
		// The wallet's side: +200.00 into it, paired with the card line.
		const legs = (await all()).filter((l) => l.account_id === P.id);
		expect(legs).toHaveLength(1);
		expect(legs[0]).toMatchObject({ kind: "transfer", bill_minor: -20000, transfer_group: after.transfer_group, counter_account_id: CARD_C.id });
		expect(await spending()).toBe(0); // 20000 − 20000: a transfer between his own accounts
		expect(await balance(P.id)).toBe(20000); // 0 opening + 20000 in
		expect(await balance(G.id)).toBe(4200); // GrabPay untouched
		// Saying it twice changes nothing.
		await markWalletTopUp(e, id, P.id);
		expect((await all()).filter((l) => l.account_id === P.id)).toHaveLength(1);
		expect(await balance(P.id)).toBe(20000);
	});

	it("by the rule, for the next one: a round S$100 at Sample Bistro is a top-up; a S$23.40 meal paid by card stays spending", async () => {
		const topup = await getLine(db, idOf(await ingestEvidence(e, cardAlert(HG, 10000, "2026-10-21"))));
		expect(topup).toMatchObject({ kind: "transfer", counter_account_id: P.id });
		const meal = await getLine(db, idOf(await ingestEvidence(e, cardAlert(HG, 2340, "2026-10-22"))));
		expect(meal).toMatchObject({ kind: "purchase", counter_account_id: null });
		expect(await spending()).toBe(2340);
		expect(await balance(P.id)).toBe(10000);
	});

	it("The owner's word beats the rule: a round amount he says was a meal is spending, and the wallet's side goes away", async () => {
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 4000, "2026-10-21")));
		expect(await balance(P.id)).toBe(4000);
		await setLineKind(e, id, "purchase");
		expect(await getLine(db, id)).toMatchObject({ kind: "purchase" });
		expect(await spending()).toBe(4000);
		expect(await balance(P.id)).toBe(0);
	});

	it("and his payee rule beats it for every line: a payee he said is spending is never taken as a top-up", async () => {
		await setPayeeRule(e, merchantKey(HG, e.aliases)!, { kind: "purchase" }, { cardLines: true });
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 5000, "2026-10-23")));
		expect(await getLine(db, id)).toMatchObject({ kind: "purchase" });
		expect(await balance(P.id)).toBe(0);
	});
});

describe("spending from the prepaid card: by the owner's word only", () => {
	const spend = (amount: number, date: string, merchant: string, category?: string) => addCash(e, { account_id: P.id, txn_date: date, currency: "SGD", amount_minor: amount, merchant, category });

	it("a S$18.50 meal after the S$200 top-up: the balance goes down to S$181.50, counted as spending once (no offset: nothing was pre-counted)", async () => {
		await ingestEvidence(e, cardAlert(HG, 20000, "2026-10-19")); // the round top-up, by the rule
		const meal = await spend(1850, "2026-10-20", "Sample Bistro - lunch", "Food");
		expect(meal).toMatchObject({ account_id: P.id, kind: "purchase", category: "Food", home_minor: 1850, state: "open" });
		expect((await all()).some((l) => l.kind === "wallet_offset")).toBe(false);
		expect(await spending()).toBe(1850); // the top-up 0 + the meal 1850
		expect(await balance(P.id)).toBe(20000 - 1850); // 18150
		// No statements: never provisional, never waiting for one.
		const [view] = await lineViews(db, [meal]);
		expect(view!.provisional).toBe(false);
		expect(view!.flags).not.toContain("needs_review");
	});

	it("a meal that takes the balance below zero is still recorded, but flagged for a look with a plain note", async () => {
		const meal = await spend(2500, "2026-10-20", "Sample Bistro - dinner", "Food"); // nothing topped up yet: 0 − 2500
		expect(meal).toMatchObject({ kind: "purchase", home_minor: 2500, state: "review" });
		expect(meal.note).toContain("Sample Bistro 儲值卡餘額變成 −SGD 25.00");
		expect(meal.note).toContain("儲值還沒記到");
		expect(await spending()).toBe(2500);
		expect(await balance(P.id)).toBe(-2500);
		const [view] = await lineViews(db, [meal]);
		expect(view!.flags).toContain("needs_review");
		// Inside the balance: no flag.
		await ingestEvidence(e, cardAlert(HG, 10000, "2026-10-21"));
		const next = await spend(1000, "2026-10-21", "Sample Bistro - coffee", "Food"); // 7500 − 1000 = 6500
		expect(next.state).toBe("open");
		expect(next.note).toBeNull();
	});

	it("cannot be added before the card's start date, and holds SGD only", async () => {
		await expect(spend(500, "2026-10-18", "Sample Bistro", "Food")).rejects.toThrow(/2026-10-19/);
		await expect(addCash(e, { account_id: P.id, txn_date: "2026-10-20", currency: "MYR", amount_minor: 500, merchant: "x" })).rejects.toThrow(/SGD/);
	});

	it("coverage is honest: its balance is only what the owner told the ledger — GrabPay's message unchanged", async () => {
		await ingestEvidence(e, cardAlert(HG, 20000, "2026-10-19"));
		await spend(1850, "2026-10-20", "Sample Bistro - lunch", "Food");
		const cov = await coverageFor(db, (await loadAccountMap(db)).values(), "2026-10-20");
		const mine = cov.find((c) => c.account_id === P.id)!;
		expect(mine).toMatchObject({ mode: "wallet", partial: false, wallet: { since: "2026-10-19", balance: { minor: 18150 }, precounted_left: { minor: 0 } } });
		expect(mine.message).toBe("Sample Bistro 儲值卡：餘額只算你告訴我的消費");
		expect(cov.find((c) => c.account_id === G.id)!.message).toContain("從 2026-10-14 起記錄；之前的儲值已算作支出");
		const views = await accountViews(db);
		expect(views.find((a) => a.id === P.id)!.wallet).toMatchObject({ told_only: true });
		expect(views.find((a) => a.id === G.id)!.wallet).toMatchObject({ told_only: false });
	});
});

describe("GrabPay is unchanged with a second wallet beside it", () => {
	it("The owner's older word (no wallet named) still means GrabPay; a Grab top-up still lands in GrabPay only", async () => {
		const bank = { ...cardAlert("GRAB", 1234, "2026-10-20", BANK), institution: BANK.institution };
		const id = idOf(await ingestEvidence(e, bank)); // odd amount: spending, as before
		await markWalletTopUp(e, id);
		expect(await getLine(db, id)).toMatchObject({ kind: "transfer", counter_account_id: G.id });
		expect(await balance(G.id)).toBe(4200 + 1234);
		expect(await balance(P.id)).toBe(0);
		await ingestEvidence(e, { ...cardAlert("GRAB", 2000, "2026-10-21", BANK) });
		expect(await balance(G.id)).toBe(4200 + 1234 + 2000);
		expect(await balance(P.id)).toBe(0);
	});

	it("GrabPay spending past its balance is not flagged — its own mail and statement keep it, as before", async () => {
		const ride = await addCash(e, { account_id: G.id, txn_date: "2026-10-20", currency: "SGD", amount_minor: 5000, merchant: "GrabCar", category: "Grab/Uber" });
		expect(ride.state).toBe("open"); // 4200 − 5000 < 0, yet no flag: a top-up may simply not have arrived yet
		expect(await balance(G.id)).toBe(4200 - 5000);
	});

	it("a top-up only goes to a wallet, from one of his banks or cards", async () => {
		const id = idOf(await ingestEvidence(e, cardAlert(HG, 2340, "2026-10-20")));
		await expect(markWalletTopUp(e, id, CARD_A.id)).rejects.toThrow(/not one of your wallets/);
		const cash = await addCash(e, { account_id: CASH.id, txn_date: "2026-10-20", currency: "SGD", amount_minor: 1000, merchant: "x" });
		await expect(markWalletTopUp(e, cash.id, P.id)).rejects.toThrow(/bank accounts or cards/);
	});
});
