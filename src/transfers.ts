/// The owner's rule: paying a card bill, and moving money between his own accounts,
/// is NEVER spending. Getting this wrong is the most expensive mistake the
/// ledger can make — a card bill counted as spending double-counts a whole
/// month — so the rules lean towards "not spending, look again" when a line
/// looks like a payment to one of his own cards.

import { daysBetween } from "./dates";
import { topUpWallet, TOPUP_WORDS } from "./wallet";
import { SPENDING_KINDS, type Account, type EvidenceDetails, type KindHint, type LineKind, type LineRow } from "./types";

export interface KindInput {
	kind_hint: KindHint | null;
	merchant_raw: string | null;
	amount_minor: number; // signed: + money out / debt up
	details: EvidenceDetails;
	/// The day it happened: a wallet top-up counts only from the wallet's cut-over date.
	txn_date?: string | null;
}

export interface KindResult {
	kind: LineKind;
	counter_account_id: string | null; // the other own account, when known
	review: boolean; // rules could not decide safely
}

/// Words a card statement uses for the owner's payment arriving.
const PAYMENT_WORDS = /PAYMENT|THANK ?YOU|AUTO ?PAY|GIRO|繳款|自動扣繳|轉帳繳/;
/// Words a card statement uses for a payment taken by auto-debit from a bank
/// account (台新「台新銀行帳戶自動轉帳扣繳台新信用卡款」, GIRO, "AUTO DEBIT").
export const AUTO_DEBIT_WORDS = /自動轉帳扣繳|自動扣繳|自動轉帳|自扣|AUTO ?-?DEBIT|AUTOPAY|AUTO ?PAY|GIRO|DIRECT DEBIT/;
/// Words a bank uses for moving money.
const TRANSFER_WORDS = /TRANSFER|FUNDS? TRF|\bTRF\b|PAYNOW|\bFAST\b|轉帳|匯款/;
/// Words a bank uses for paying a bill or sending money abroad.
const BILL_WORDS = /\bBILL\b|REMIT|\bTT\b|GIRO|IBG|繳費|繳款/;
const ISSUER_WORDS: Readonly<Record<string, RegExp>> = {
	dbs: /\bDBS\b|\bPOSB\b/,
	hsbc: /\bHSBC\b/,
	citi: /\bCITI(BANK)?\b/,
	taishin: /TAISHIN|台新/,
};

function upper(s: string | null): string {
	return (s ?? "").normalize("NFKC").toUpperCase();
}

/// The own account a piece of evidence points at, if it names one.
export function resolveCounterparty(details: EvidenceDetails, merchantRaw: string | null, accounts: readonly Account[], self: Account): Account | null {
	const others = accounts.filter((a) => a.id !== self.id);
	const cp = details.counterparty;
	if (cp?.last4) {
		const byLast4 = others.filter((a) => a.last4 === cp.last4 && (!cp.institution || a.institution === cp.institution));
		if (byLast4.length === 1) return byLast4[0]!;
	}
	// A descriptor that spells out one of his own card numbers' last 4.
	const text = upper(merchantRaw);
	const named = others.filter((a) => a.last4 && new RegExp(`(?<!\\d)${a.last4}(?!\\d)`).test(text));
	if (named.length === 1) return named[0]!;
	return null;
}

/// The ONE credit card of the owner's whose last 4 digits the text spells out
/// ("Other bank's card ending 5502"), among his credit cards only — a debit
/// card or bank account that happens to share the digits never makes it
/// ambiguous, because a card bill is only ever paid to a credit card.
export function cardNamedIn(merchantRaw: string | null | undefined, accounts: readonly Account[]): Account | null {
	const text = upper(merchantRaw ?? null);
	if (!text) return null;
	const named = accounts.filter((a) => a.kind === "credit_card" && a.last4 && new RegExp(`(?<!\\d)${a.last4}(?!\\d)`).test(text));
	return named.length === 1 ? named[0]! : null;
}

/// The card a bank line's card payment paid: the counter account when it is
/// one of his credit cards, else the one card its descriptor names, else null.
/// The safety net for a card_payment whose counter was never filled in.
export function paidCard(line: Pick<LineRow, "account_id" | "counter_account_id" | "merchant_raw">, accounts: readonly Account[]): Account | null {
	const counter = line.counter_account_id ? accounts.find((a) => a.id === line.counter_account_id) : undefined;
	if (counter?.kind === "credit_card") return counter;
	const self = accounts.find((a) => a.id === line.account_id);
	if (self) {
		const named = resolveCounterparty({}, line.merchant_raw, accounts, self);
		if (named?.kind === "credit_card") return named;
	}
	return cardNamedIn(line.merchant_raw, accounts);
}

/// A bank line made a card_payment (by the rules, a payee rule or the owner's
/// word) keeps the card it paid: when its counter is not one of his credit
/// cards, the card its descriptor names fills it. A counter that IS a credit
/// card is never changed.
export function withCardCounter<K extends { kind: LineKind; counter_account_id: string | null }>(k: K, account: Pick<Account, "id" | "kind">, merchantRaw: string | null, accounts: readonly Account[]): K {
	if (k.kind !== "card_payment" || (account.kind !== "bank" && account.kind !== "debit_card")) return k;
	const card = paidCard({ account_id: account.id, counter_account_id: k.counter_account_id, merchant_raw: merchantRaw }, accounts);
	return card && card.id !== k.counter_account_id ? { ...k, counter_account_id: card.id } : k;
}

/// A card statement line that reads as the owner's payment arriving ("PAYMENT -
/// THANK YOU", 「自動轉帳扣繳」), by its words alone.
export function readsAsCardPayment(text: string | null | undefined): boolean {
	return PAYMENT_WORDS.test(upper(text ?? null));
}

function namesOwnPerson(details: EvidenceDetails, merchantRaw: string | null, ownNames: readonly string[]): boolean {
	const hay = upper(details.counterparty?.name ?? null) + " " + upper(merchantRaw);
	return ownNames.some((n) => n.trim().length >= 3 && hay.includes(upper(n)));
}

/// An own credit card at the issuer the text names ("HSBC CARD PAYMENT").
function issuerCard(merchantRaw: string | null, accounts: readonly Account[]): Account[] {
	const text = upper(merchantRaw);
	return accounts.filter((a) => a.kind === "credit_card" && ISSUER_WORDS[a.institution]?.test(text));
}

export function classifyKind(input: KindInput, account: Account, accounts: readonly Account[], ownNames: readonly string[]): KindResult {
	const text = upper(input.merchant_raw);
	const counter = resolveCounterparty(input.details, input.merchant_raw, accounts, account);
	const result = (kind: LineKind, review = false, counterAccount: Account | null = counter): KindResult => ({
		kind,
		counter_account_id: counterAccount?.id ?? null,
		review,
	});

	switch (input.kind_hint) {
		case "refund":
			return result("refund");
		case "fee":
		case "fx_fee":
			return result("fee");
		case "rebate":
			return result("rebate");
		case "atm":
			return result("transfer", false, accounts.find((a) => a.kind === "cash") ?? null);
		default:
			break;
	}

	// A wallet (GrabPay): money coming in that is not a refund or an
	// income is a top-up — the owner's own money moving, never spending or income.
	if (account.kind === "wallet" && input.amount_minor < 0 && (input.kind_hint === "transfer" || input.kind_hint === "payment" || TOPUP_WORDS.test(text))) {
		return result("transfer", false, null);
	}
	// Money from his bank or card into one of his wallets, from its cut-over
	// date on: a transfer to his own wallet — GrabPay by its own rule, any other
	// prepaid wallet by its data rule (src/wallet.ts topUpWallet).
	const wallet = input.kind_hint !== "income" ? topUpWallet(accounts, account, input.merchant_raw, input.amount_minor, input.txn_date) : null;
	if (wallet) return result("transfer", false, wallet);

	// On a credit card, money coming IN that reads like a payment is his bill
	// being paid — never a refund, never income.
	if (account.kind === "credit_card" && input.amount_minor < 0 && (input.kind_hint === "payment" || PAYMENT_WORDS.test(text))) {
		return result("card_payment");
	}

	if (account.kind === "bank" || account.kind === "debit_card") {
		if (counter?.kind === "credit_card") return result("card_payment");
		if (counter) return result("transfer");
		// "Other bank's card ending 5502" (DBS's alert for paying another
		// bank's card): one of his credit cards named by its digits, even when
		// another of his accounts shares them (14 Oct 2026).
		const namedCard = /CARD/.test(text) ? cardNamedIn(input.merchant_raw, accounts) : null;
		if (namedCard) return result("card_payment", false, namedCard);
		// "HSBC CARD PAYMENT" with no number: still one of his cards.
		const cards = issuerCard(input.merchant_raw, accounts);
		if (cards.length > 0 && (PAYMENT_WORDS.test(text) || /CARD/.test(text) || input.kind_hint === "payment")) {
			return result("card_payment", false, cards.length === 1 ? cards[0]! : null);
		}
		// The owner's rule (round 2): EVERY transfer out of his bank to one of his
		// card issuers is that card's bill — "TRF TO CITIBANK", "BILL PAYMENT
		// HSBC", "REMITTANCE 台新". Never spending.
		if (account.kind === "bank" && cards.length > 0 && input.amount_minor > 0 && (input.kind_hint === "transfer" || TRANSFER_WORDS.test(text) || BILL_WORDS.test(text))) {
			return result("card_payment", false, cards.length === 1 ? cards[0]! : null);
		}
		if ((input.kind_hint === "transfer" || TRANSFER_WORDS.test(text)) && namesOwnPerson(input.details, input.merchant_raw, ownNames)) {
			return result("transfer");
		}
		// "UOB CARD PAYMENT" — a card bill, but not a card on his list. Never
		// spending; held for a look, because it may be a card he has not listed.
		if (/CARD/.test(text) && PAYMENT_WORDS.test(text) && input.amount_minor > 0) {
			return result("card_payment", true, null);
		}
	}

	if (input.kind_hint === "income") return result(counter ? "transfer" : "income");
	if (input.kind_hint === "transfer" || input.kind_hint === "payment") {
		// To someone else: money out is spending (PayNow for dinner), money in is income.
		return result(input.amount_minor >= 0 ? "purchase" : "income");
	}

	if (input.amount_minor < 0) {
		// Money back with no hint. On a card that is a refund; in a bank it is income.
		return result(account.kind === "credit_card" ? "refund" : "income");
	}
	return result("purchase");
}

export function isSpending(line: Pick<LineRow, "kind" | "state">): boolean {
	return SPENDING_KINDS.has(line.kind) && line.state !== "void";
}

/// The other leg of an own-account transfer: a different account, a
/// transfer/card_payment line, the opposite sign and the same size in the same
/// currency, within 3 days, not already paired. The leg on the named counter
/// account wins; otherwise the nearest date.
export const TRANSFER_WINDOW_DAYS = 3;

export function findTransferPair(
	line: Pick<LineRow, "id" | "account_id" | "kind" | "bill_currency" | "bill_minor" | "txn_date">,
	counterAccountId: string | null,
	candidates: readonly LineRow[],
): LineRow | null {
	if (line.kind !== "transfer" && line.kind !== "card_payment") return null;
	const fits = candidates.filter(
		(c) =>
			c.id !== line.id &&
			c.account_id !== line.account_id &&
			c.state !== "void" &&
			c.transfer_group === null &&
			(c.kind === "transfer" || c.kind === "card_payment") &&
			c.bill_currency === line.bill_currency &&
			c.bill_minor === -line.bill_minor &&
			Math.abs(daysBetween(c.txn_date, line.txn_date)) <= TRANSFER_WINDOW_DAYS,
	);
	fits.sort(
		(a, b) =>
			Number(b.account_id === counterAccountId) - Number(a.account_id === counterAccountId) ||
			Math.abs(daysBetween(a.txn_date, line.txn_date)) - Math.abs(daysBetween(b.txn_date, line.txn_date)) ||
			a.created_at.localeCompare(b.created_at) ||
			a.id.localeCompare(b.id),
	);
	return fits[0] ?? null;
}

/// The owner's rule, by amount: a card's "payment received" line and money out of
/// his bank account of exactly that amount, in the same currency, within this
/// many days. The bank line may have been read as a payment to someone (its
/// descriptor names no card issuer); the exact match is the evidence.
export const CARD_PAYMENT_WINDOW_DAYS = 5;

/// PayNow goes to a person or a shop, never to a card bill on its own.
const TO_A_PERSON = /PAYNOW/;
/// Words a bank prints about paying or moving money, or naming a bank, a
/// card or an issuer: what is left of a payee once these (and numbers) are
/// taken out is a NAME — a person (masked "TAN AH-KXXX" too) or a shop.
const BANK_TOKENS = new Set(
	(
		"PAYMENT PAYMT PMT PYMT PAY THANK YOU AUTO AUTOPAY GIRO TRANSFER TRANSFERS TRF TRFR FUNDS FUND FAST IBG MEPS BILL BILLS " +
		"REMIT REMITTANCE TT INTERBANK ONLINE IB INB IBANKING DIGIBANK CARD CARDS CREDIT CC VISA MASTERCARD MASTER AMEX BANK " +
		"DBS POSB HSBC CITI CITIBANK CITICARD TAISHIN UOB OCBC MAYBANK SCB STANDARD CHARTERED TO FROM FOR REF NO ADVICE DEBIT " +
		"AC ACCT ACCOUNT SGD TWD OTHR OTHER SI STANDING INSTRUCTION OUTWARD OUTGOING ICT"
	).split(" "),
);
const BANK_CJK = /自動扣繳|轉帳繳|繳款|轉帳|匯款|繳費|卡費|信用卡|台新|銀行|國際|股份|有限公司|轉出/g;

/// Who a bank line's money went to, as far as its descriptor says:
///   none   no payee printed at all (DBS's plain outgoing transfer)
///   bank   only bank / card / issuer / transfer words and reference numbers
///   person a name — a person or a shop. Never a card bill by amount alone.
export type PayeeReading = "none" | "bank" | "person";
export function readPayee(merchantRaw: string | null | undefined): PayeeReading {
	const text = upper(merchantRaw ?? null);
	if (!/[\p{L}\p{N}]/u.test(text)) return "none";
	if (TO_A_PERSON.test(text)) return "person";
	const left = text
		.replace(BANK_CJK, " ")
		.split(/[^\p{L}]+/u)
		.filter((w) => w.length > 1 && !BANK_TOKENS.has(w));
	return left.length ? "person" : "bank";
}

type PayLine = Pick<LineRow, "id" | "account_id" | "kind" | "state" | "bill_currency" | "bill_minor" | "txn_date" | "transfer_group" | "merchant_raw" | "created_at">;

/// What matching by amount alone decided: the one candidate (`pick`), or the
/// equally good candidates it would not choose between (`tied`, 2 or more —
/// for 待確認), or neither.
export interface AmountDecision<T> {
	pick: T | null;
	tied: T[];
}

/// The bank line that paid this card payment, by amount (bank → card), or the
/// card payment a bank line paid (card → bank). `bankIds` = his bank accounts.
/// A bank line whose payee reads as a person (or a shop) is never matched by
/// amount alone (25 Jun: a masked name beat the real, no-payee card
/// payment). Among the rest a line with no payee beats one with bank words,
/// then the nearest date; two equally good = no pick, never a guess.
export function decideCardPaymentByAmount<T extends PayLine>(line: PayLine, bankIds: ReadonlySet<string>, candidates: readonly T[]): AmountDecision<T> {
	const none: AmountDecision<T> = { pick: null, tied: [] };
	const lineIsBank = bankIds.has(line.account_id);
	if (line.state === "void" || line.transfer_group !== null) return none;
	if (lineIsBank ? !(line.kind === "purchase" && line.bill_minor > 0 && readPayee(line.merchant_raw) !== "person") : !(line.kind === "card_payment" && line.bill_minor < 0)) return none;
	const fits = candidates.filter((c) => {
		if (c.id === line.id || c.state === "void" || c.transfer_group !== null || c.bill_currency !== line.bill_currency || c.bill_minor !== -line.bill_minor) return false;
		if (Math.abs(daysBetween(c.txn_date, line.txn_date)) > CARD_PAYMENT_WINDOW_DAYS) return false;
		return lineIsBank ? c.kind === "card_payment" && !bankIds.has(c.account_id) : bankIds.has(c.account_id) && c.kind === "purchase" && readPayee(c.merchant_raw) !== "person";
	});
	if (!fits.length) return none;
	const tier = (c: T) => (lineIsBank ? 0 : readPayee(c.merchant_raw) === "none" ? 0 : 1);
	const gap = (c: T) => Math.abs(daysBetween(c.txn_date, line.txn_date));
	fits.sort((a, b) => tier(a) - tier(b) || gap(a) - gap(b) || a.id.localeCompare(b.id));
	const best = fits.filter((c) => tier(c) === tier(fits[0]!) && gap(c) === gap(fits[0]!));
	return best.length > 1 ? { pick: null, tied: best } : { pick: best[0]!, tied: [] };
}

/// decideCardPaymentByAmount's one pick, or null.
export function findCardPaymentByAmount<T extends PayLine>(line: PayLine, bankIds: ReadonlySet<string>, candidates: readonly T[]): T | null {
	return decideCardPaymentByAmount(line, bankIds, candidates).pick;
}

/// For the upkeep's look back over old lines: would the rules today call this
/// bank line a card payment? Same rule as classifyKind, from what the line
/// kept (its descriptor and sign); the evidence hint is not needed because a
/// card issuer named on money leaving the bank is enough.
export function cardPaymentTarget(line: Pick<LineRow, "account_id" | "kind" | "bill_minor" | "merchant_raw">, accounts: readonly Account[]): { card_payment: boolean; counter_account_id: string | null } {
	const self = accounts.find((a) => a.id === line.account_id);
	const no = { card_payment: false, counter_account_id: null };
	if (!self || self.kind !== "bank" || line.bill_minor <= 0) return no;
	if (line.kind !== "purchase" && line.kind !== "transfer") return no;
	const counter = resolveCounterparty({}, line.merchant_raw, accounts, self);
	if (counter?.kind === "credit_card") return { card_payment: true, counter_account_id: counter.id };
	if (counter) return no;
	const text = upper(line.merchant_raw);
	const namedCard = /CARD/.test(text) ? cardNamedIn(line.merchant_raw, accounts) : null;
	if (namedCard) return { card_payment: true, counter_account_id: namedCard.id };
	const cards = issuerCard(line.merchant_raw, accounts);
	if (cards.length > 0 && (PAYMENT_WORDS.test(text) || /CARD/.test(text) || TRANSFER_WORDS.test(text) || BILL_WORDS.test(text))) {
		return { card_payment: true, counter_account_id: cards.length === 1 ? cards[0]!.id : null };
	}
	return no;
}
