/// A stored-value (prepaid) wallet — GrabPay (14 Oct 2026), and since
/// 19 Oct 2026 any prepaid card the owner declares (Sample Bistro). The owner's rules:
///
///   * A wallet is recorded from its cut-over date (`wallet_since`) with the
///     balance it held at the start of that day. Nothing earlier is recorded on
///     it: the top-ups before then were counted as spending, and stay so.
///   * A top-up (money from his own bank or card into the wallet) is a transfer
///     between his own accounts — never spending. The wallet's balance goes up.
///   * Spending from the wallet is one line per purchase, in its real category.
///   * The opening balance was ALREADY counted as spending (in the old
///     top-ups). The purchases that use it up — first in, first out, until
///     `wallet_precounted_minor` is gone — each get an automatic offset line
///     (kind `wallet_offset`, negative, in the old top-ups' category), so they
///     show in their real category but add nothing to the totals a second time.
///     After that, wallet spending counts normally.
///
/// Every wallet works the same way. What differs is only data on its account
/// row: its start date, opening and pre-counted balance (migration 0010), and
/// its own top-up rule (migration 0012: merchant text + whole dollars only).
/// GrabPay alone keeps its older, richer top-up rule in code (institution
/// "grab": top-up words, "GRAB* A-…" rides, the bare "GRAB" on a bank) and its
/// own verified mail; a wallet with no statements (has_statements 0) knows only
/// what the owner tells it.
///
/// Pure rules here; the writes are in engine.ts (settleWallet, the top-up legs).

import type { Db } from "./db";
import { exponent, money, type Money } from "./money";
import type { Account, LineRow } from "./types";
import { homeCurrency, homeMoney, localDate } from "./home";
import { say } from "./words";

export type WalletAccount = Account & { kind: "wallet"; wallet_since: string };

export function isWallet(a: Account | null | undefined): a is WalletAccount {
	return !!a && a.kind === "wallet" && typeof a.wallet_since === "string" && a.wallet_since.length === 10;
}

/// The (one, active) wallet of an institution — GrabPay is "grab".
export function walletOf(accounts: readonly Account[], institution: string): WalletAccount | null {
	const hits = accounts.filter((a): a is WalletAccount => isWallet(a) && a.institution === institution && a.active === 1);
	return hits.length === 1 ? hits[0]! : null;
}

/// GrabPay's institution: its top-up rule and its mail are in code.
export const GRAB = "grab";

/// A wallet whose balance is only what the owner tells the ledger: no statements,
/// no mail (Sample Bistro). Its coverage says so in the owner's words.
export function toldOnly(wallet: Pick<Account, "kind" | "has_statements">): boolean {
	return wallet.kind === "wallet" && wallet.has_statements === 0;
}

/// What an offset line says about itself (merchant and note), and what a
/// purchase it covers says (LineView.wallet). Written in the owner's language when
/// the line is made, like any note; nothing ever matches on these words (the line's
/// kind, wallet_offset, says what it is).
export const offsetMerchant = () => say("wallet.offset_merchant");
export const offsetNote = (wallet: Pick<Account, "name" | "wallet_since">) => say("wallet.offset_note", { since: String(wallet.wallet_since), name: wallet.name });

/// Which purchases a wallet's pre-counted balance pays for, and how much of
/// each: first in, first out by purchase date (then by when the line was made,
/// then id — stable, so asking twice gives the same answer). Only money out
/// counts (purchases and fees); a refund back into the wallet is counted as an
/// ordinary refund and gives nothing back to the pool — then "counted so far"
/// still equals "really spent + pre-counted money still in the wallet".
export function planOffsets(
	pool: number,
	since: string,
	lines: readonly Pick<LineRow, "id" | "kind" | "state" | "txn_date" | "created_at" | "home_minor" | "merged_into">[],
): Map<string, number> {
	const out = new Map<string, number>();
	let left = Math.max(0, pool);
	const spends = lines
		.filter((l) => (l.kind === "purchase" || l.kind === "fee") && l.state !== "void" && !l.merged_into && l.home_minor > 0 && l.txn_date >= since)
		.sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
	for (const s of spends) {
		const take = Math.min(left, s.home_minor);
		if (take > 0) out.set(s.id, take);
		left -= take;
	}
	return out;
}

// ------------------------------------------------------------- top-ups

function upper(s: string | null | undefined): string {
	return (s ?? "").normalize("NFKC").toUpperCase().trim();
}

/// Words that say money went INTO a wallet.
export const TOPUP_WORDS = /TOP\s*-?\s*UP|TOPUP|RELOAD|儲值|加值/;
/// A Grab line that is a ride or an order paid straight from a card — "GRAB* A-7F3K2",
/// "GRABFOOD", "GRABCAR": spending, never a top-up.
const DIRECT_GRAB = /GRAB\s*\*|GRAB\s*(?:FOOD|CAR|MART|TAXI|EXPRESS|BIKE|HITCH|SHARE|RIDES?)\b|GRAB(?:FOOD|CAR|MART|TAXI|EXPRESS|BIKE)/;
/// The bare "GRAB" (maybe with its company words) a DBS account line shows for a top-up.
const BARE_GRAB = /^GRAB(?:[\s.,-]+(?:PTE|LTD|SINGAPORE|SG|SGP|HOLDINGS|TECHNOLOGIES|TECHNOLOGY|GRABPAY|PAY|WALLET))*[\s.,]*$/;

/// Does Grab's name appear in this text (not "GRABBER", not a URL fragment)?
export function namesGrab(merchantRaw: string | null | undefined): boolean {
	return /(?<![A-Z])GRAB/.test(upper(merchantRaw));
}

/// A Grab ride or order paid straight from a card carries its booking code:
/// "GRAB* A-7F3K2", "Grab* 2-4ABC". Never a top-up, whatever the amount.
export function isDirectGrabCharge(merchantRaw: string | null | undefined): boolean {
	const text = upper(merchantRaw);
	return !TOPUP_WORDS.test(text) && DIRECT_GRAB.test(text);
}

/// Is this line on one of the owner's own accounts money he put into the wallet?
///   * a line that says top-up and names Grab, on a bank, debit or credit
///     card (never a direct ride or order: "GRAB* A-…", "GRABFOOD");
///   * on a BANK account: the bare "GRAB" for a whole number of dollars
///     (S$10, S$20, S$50 — how DBS shows the owner's top-ups). An odd amount there
///     is spending, as before.
/// Only from the wallet's cut-over date: older top-ups stay spending (the owner).
export function looksLikeTopUp(account: Pick<Account, "kind">, merchantRaw: string | null | undefined, amountMinor: number, txnDate: string | null | undefined, wallet: WalletAccount | null): boolean {
	if (!wallet || !txnDate || txnDate < wallet.wallet_since || amountMinor <= 0) return false;
	if (account.kind !== "bank" && account.kind !== "debit_card" && account.kind !== "credit_card") return false;
	const text = upper(merchantRaw);
	if (!namesGrab(text)) return false;
	if (TOPUP_WORDS.test(text)) return true;
	if (DIRECT_GRAB.test(text)) return false;
	return account.kind === "bank" && amountMinor % 100 === 0 && BARE_GRAB.test(text);
}

/// Letters and digits only, upper case: "Sample Bistro  Singapore" → "SAMPLEBISTROSINGAPORE".
function squeeze(s: string | null | undefined): string {
	return upper(s).replace(/[^\p{L}\p{N}]+/gu, "");
}

/// A wallet's own top-up rule (migration 0012), when it has one: the merchant
/// texts a card or bank line must contain (any one; since 0013 the column may
/// list several, comma-separated), and whether only whole dollars count.
export function topUpRule(wallet: Pick<Account, "wallet_topup_merchant" | "wallet_topup_whole_dollars">): { merchants: string[]; whole_dollars: boolean } | null {
	const merchants = (wallet.wallet_topup_merchant ?? "").split(/[,，、]/).map(squeeze).filter(Boolean);
	return merchants.length ? { merchants, whole_dollars: wallet.wallet_topup_whole_dollars === 1 } : null;
}

/// Does this bank or card line fit the wallet's own top-up rule? From its start
/// date only; money out only; whole dollars when the rule says so (a meal paid
/// by card at the same shop for S$23.40 stays a purchase).
export function fitsTopUpRule(account: Pick<Account, "kind">, merchantRaw: string | null | undefined, amountMinor: number, txnDate: string | null | undefined, wallet: WalletAccount): boolean {
	const rule = topUpRule(wallet);
	if (!rule || !txnDate || txnDate < wallet.wallet_since || amountMinor <= 0) return false;
	if (account.kind !== "bank" && account.kind !== "debit_card" && account.kind !== "credit_card") return false;
	if (rule.whole_dollars && amountMinor % 100 !== 0) return false;
	const text = squeeze(merchantRaw);
	return rule.merchants.some((m) => text.includes(m));
}

/// Which of the owner's wallets (if any) this bank or card line is a top-up of:
/// GrabPay by its own rule, any other wallet by its data rule. Two wallets
/// both claiming it: none (it stays a purchase; the owner can say which).
export function topUpWallet(accounts: readonly Account[], account: Pick<Account, "kind">, merchantRaw: string | null | undefined, amountMinor: number, txnDate: string | null | undefined): WalletAccount | null {
	const hits: WalletAccount[] = [];
	const grab = walletOf(accounts, GRAB);
	if (grab && looksLikeTopUp(account, merchantRaw, amountMinor, txnDate, grab)) hits.push(grab);
	for (const w of accounts) {
		if (!isWallet(w) || w.active !== 1 || w.institution === GRAB) continue;
		if (fitsTopUpRule(account, merchantRaw, amountMinor, txnDate, w)) hits.push(w);
	}
	return hits.length === 1 ? hits[0]! : null;
}

// ------------------------------------------------------------- balance

export interface WalletState {
	account_id: string;
	since: string;
	/// What is in the wallet now (opening − money out + money in, since the cut-over):
	/// the shop's CREDIT (its own unit — 224.26 on a card that gave 240 for S$200).
	balance: Money;
	/// How much of the pre-counted opening balance purchases have not used up yet (money).
	precounted_left: Money;
	precounted_category: string | null;
	/// What that remaining credit is worth in real money (SGD), lot by lot, first
	/// in first out (19 Oct 2026, the owner: "I can't see where the S$200 went") —
	/// prepaid and not used yet. Equal to the balance when no top-up had a bonus.
	remaining_value: Money;
}

/// Each wallet's balance, pre-counted money left and remaining real value: ONE
/// query for all of them. `asOf` (YYYY-MM-DD) = as at the end of that day.
export async function walletStates(db: Db, wallets: readonly Account[], asOf?: string): Promise<Map<string, WalletState>> {
	const list = wallets.filter(isWallet);
	const out = new Map<string, WalletState>();
	if (!list.length) return out;
	const rows = (
		await db
			.prepare(
				"SELECT l.account_id, l.id, l.kind, l.state, l.txn_date, l.created_at, l.bill_minor, l.home_minor, l.merged_into " +
					"FROM lines l JOIN accounts a ON a.id = l.account_id WHERE a.kind = 'wallet' AND l.state <> 'void' AND l.merged_into IS NULL AND l.txn_date >= a.wallet_since AND l.txn_date <= ?",
			)
			.bind(asOf ?? "9999-12-31")
			.all<CostLine & { account_id: string }>()
	).results;
	for (const w of list) {
		const mine = rows.filter((x) => x.account_id === w.id);
		const moved = mine.filter((x) => x.kind !== "wallet_offset").reduce((s, x) => s + x.bill_minor, 0);
		const offset = mine.filter((x) => x.kind === "wallet_offset").reduce((s, x) => s + x.home_minor, 0);
		const opening = w.wallet_opening_minor ?? 0;
		const pre = w.wallet_precounted_minor ?? 0;
		out.set(w.id, {
			account_id: w.id,
			since: w.wallet_since,
			// Money out (+) makes the balance go down; a top-up (−) makes it go up.
			balance: money(opening - moved, w.currency),
			// Offsets are negative: adding them uses the pool up.
			precounted_left: money(Math.max(0, pre + offset), w.currency),
			precounted_category: w.wallet_precounted_category ?? null,
			remaining_value: homeMoney(remainingValue(opening, w.wallet_opening_paid_minor ?? null, w.wallet_since, mine)),
		});
	}
	return out;
}

// ------------------------------------------------------------- bonus credit (19 Oct 2026)
//
// The owner: "pay S$200, get 240" — the shop's credit is what the wallet holds (its
// balance matches the shop's site), but the ledger counts what the credit
// really cost him. On a wallet's lines bill_minor is the CREDIT and home_minor
// the MONEY: a top-up's wallet side holds −240.00 credit and −200.00 money; a
// meal holds the 24.00 credit it used and its real cost, S$20.00.
//
// Each top-up is its own lot with its own ratio (money paid ÷ credit got); the
// opening balance is a lot at ratio 1. Meals use the oldest lot first (first
// in, first out), splitting across lots when one runs out. A lot's cost is
// handed out by its running total — round(paid × credit used so far ÷ credit)
// — so when a lot is used up its meals add up to exactly what was paid: the
// last use absorbs the rounding, nothing drifts. Credit used beyond every lot
// (the balance below zero: a top-up not told yet) is costed at face value until
// that top-up arrives, and is worked out again then. A top-up without a bonus
// (GrabPay, every one so far) has ratio 1: every cost equals its credit.

export type CostLine = Pick<LineRow, "id" | "kind" | "state" | "txn_date" | "created_at" | "bill_minor" | "home_minor" | "merged_into">;

const byTime = (a: CostLine, b: CostLine) => a.txn_date.localeCompare(b.txn_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/// One lot of credit: the opening balance, a top-up, or any other money in
/// (a refund back into the wallet). `credit` and `paid` in minor units; `used`
/// is how much of its credit uses have taken so far (first in, first out).
export interface Lot {
	line_id: string | null; // null = the opening balance
	date: string;
	credit: number;
	paid: number;
	used: number;
}

/// The credit a lot has used so far, in money: by running total, so a used-up
/// lot's uses add to exactly what was paid for it.
export const lotCostTo = (lot: Pick<Lot, "credit" | "paid">, used: number) => (used >= lot.credit ? lot.paid : Math.round((lot.paid * used) / lot.credit));

/// What is left in a lot, in money: what was paid for it less what its uses cost.
export const lotValueLeft = (lot: Pick<Lot, "credit" | "paid" | "used">) => lot.paid - lotCostTo(lot, lot.used);

/// Walk a wallet's lines once, first in first out: each use's real cost
/// (purchases and fees only, keyed by line id) and every lot as it stands after
/// all of them. `openingPaid`: what the opening credit cost (null = the opening balance itself).
export function walkLots(opening: number, openingPaid: number | null, since: string, lines: readonly CostLine[]): { costs: Map<string, number>; lots: Lot[]; beyond: number } {
	const live = lines.filter((l) => l.kind !== "wallet_offset" && l.state !== "void" && !l.merged_into && l.txn_date >= since);
	const lots: Lot[] = [];
	if (opening > 0) lots.push({ line_id: null, date: since, credit: opening, paid: Math.max(0, openingPaid ?? opening), used: 0 });
	for (const l of live.filter((x) => x.bill_minor < 0).sort(byTime)) lots.push({ line_id: l.id, date: l.txn_date, credit: -l.bill_minor, paid: Math.max(0, -l.home_minor), used: 0 });
	const costs = new Map<string, number>();
	let i = 0;
	let beyond = 0;
	for (const s of live.filter((x) => x.bill_minor > 0).sort(byTime)) {
		let need = s.bill_minor;
		let cost = 0;
		while (need > 0 && i < lots.length) {
			const lot = lots[i]!;
			const take = Math.min(need, lot.credit - lot.used);
			if (take > 0) {
				const before = lotCostTo(lot, lot.used);
				lot.used += take;
				cost += lotCostTo(lot, lot.used) - before;
				need -= take;
			}
			if (lot.used >= lot.credit) i++;
		}
		cost += need; // beyond every lot: face value, until the missing top-up is told
		beyond += need;
		if (s.kind === "purchase" || s.kind === "fee") costs.set(s.id, cost);
	}
	return { costs, lots, beyond };
}

/// The real cost (SGD minor units) of each wallet purchase and fee, keyed by
/// line id. Every money-out line uses credit up (a transfer out too), but only
/// purchases and fees are given a cost: they are what counts as spending.
/// `openingPaid`: what the opening credit cost (null = the opening balance itself).
export function planCosts(opening: number, openingPaid: number | null, since: string, lines: readonly CostLine[]): Map<string, number> {
	return walkLots(opening, openingPaid, since, lines).costs;
}

/// What the credit still in a wallet is worth in money (the owner: "pay 200, get
/// 240" — 224.26 credit left of that lot is worth ≈ S$186.88): the sum, over
/// every lot, of what was paid for it less what its uses cost. Credit used
/// beyond every lot (a top-up not told yet) leaves nothing.
export function remainingValue(opening: number, openingPaid: number | null, since: string, lines: readonly CostLine[]): number {
	return walkLots(opening, openingPaid, since, lines).lots.reduce((s, lot) => s + lotValueLeft(lot), 0);
}

/// Credit is the shop's unit, not money: shown as a plain number ("240.00").
/// A wallet keeps the home currency (docs/accounts.md): its credit is printed with the home currency's decimals.
export const creditText = (minor: number) => {
	const e = exponent(homeCurrency());
	return `${minor < 0 ? "−" : ""}${(Math.abs(minor) / 10 ** e).toFixed(e)}`;
};

/// What a wallet line paid with bonus credit says about itself (LineView.credit).
export const creditNote = (used: string, cost: string) => say("wallet.credit_note", { used, cost });

/// A top-up's wallet side, in words: what was paid and what credit came in.
export const topUpNote = (paid: string, credit: string) => say("wallet.topup_note", { paid, credit });

/// The credit an automatic top-up gets by default: the shop's usual deal
/// ("pay 300, get 350") in proportion to what was paid; no deal = face value.
export function dealCredit(wallet: Pick<Account, "wallet_topup_deal_paid_minor" | "wallet_topup_deal_credit_minor">, paidMinor: number): number | null {
	const p = wallet.wallet_topup_deal_paid_minor;
	const c = wallet.wallet_topup_deal_credit_minor;
	return p && c && p > 0 ? Math.round((paidMinor * c) / p) : null;
}

/// The deal in words: 「付 300.00 拿 350.00」.
export const dealText = (wallet: Pick<Account, "wallet_topup_deal_paid_minor" | "wallet_topup_deal_credit_minor">) =>
	wallet.wallet_topup_deal_paid_minor && wallet.wallet_topup_deal_credit_minor ? say("wallet.deal", { paid: creditText(wallet.wallet_topup_deal_paid_minor), credit: creditText(wallet.wallet_topup_deal_credit_minor) }) : null;

/// The largest bonus the ledger believes without a second look: credit at most
/// twice what was paid (a typo — "2400" for "240" — is refused, not recorded).
export const MAX_BONUS_RATIO = 2;

// ------------------------------------------------------------- a shop's SMS (19 Oct 2026)

/// Letters and digits only, upper case — as the top-up rule compares names.
export function smsWords(raw: string | null | undefined): string[] {
	return (raw ?? "").split(/[,，、]/).map((w) => squeeze(w)).filter(Boolean);
}

/// Does this wallet take SMS at all (migration 0013: words or a sender on its row)?
export function takesSms(w: Pick<Account, "kind" | "institution" | "wallet_sms_keywords" | "wallet_sms_sender">): boolean {
	return w.kind === "wallet" && w.institution !== GRAB && (smsWords(w.wallet_sms_keywords).length > 0 || squeeze(w.wallet_sms_sender).length > 0);
}

/// Which ONE wallet an SMS belongs to — by the data on the wallets' rows only:
/// its words must appear in the text (when it has words), and its sender must
/// be the sender the Shortcut named (when it has one). None, or more than one,
/// = no wallet: the SMS is never guessed onto an account. The text is untrusted;
/// all it can do is pick among wallets the owner set up for SMS.
export function smsWallet(accounts: readonly Account[], text: string, sender: string | null | undefined): WalletAccount | null {
	const body = squeeze(text);
	const from = squeeze(sender);
	const hits = accounts.filter((a): a is WalletAccount => {
		if (!isWallet(a) || a.active !== 1 || !takesSms(a)) return false;
		const words = smsWords(a.wallet_sms_keywords);
		const want = squeeze(a.wallet_sms_sender);
		if (words.length && !words.some((w) => body.includes(w))) return false;
		if (want && from !== want) return false;
		return true;
	});
	return hits.length === 1 ? hits[0]! : null;
}

/// The day an SMS is about: the owner's day it arrived (a shop texts right after the use).
export function smsDate(receivedAt: string): string {
	return localDate(new Date(receivedAt));
}
