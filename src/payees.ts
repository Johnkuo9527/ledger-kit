/// The owner's payee rules (round 2, addition 2): his word on what the
/// money paid to a payee IS — an investment, a loan repayment, money a friend
/// handles for him, a transfer between his own accounts, a card bill, or
/// ordinary spending — and, for a few, its category (his landlords = Rent).
/// Stored in payee_rules (migration 0006). A rule beats the detection rules
/// and every model: it is applied when a line is created, by the upkeep's
/// look back over old lines, and at once when the owner sets it.
///
/// Which lines a rule covers: lines whose merchant key STARTS with the rule's
/// words ("BELLA" covers "BELLA MOBILE ENDING"); the longest such rule wins.
/// Banks mask names ("TAXX MEIXXX" for TANG MEILIN): a key none of the rules
/// covers, but whose masked words fit one rule letter for letter on the
/// letters shown, takes that rule — only when exactly one rule fits.

import type { AccountKind, LineKind, LineRow } from "./types";

/// The kinds the owner can give a line (the page's 「這筆不算花費」 and ledger_set_kind).
/// "purchase" = ordinary spending ("spending" and "own_transfer" are accepted
/// as other names for purchase and transfer).
export const OWNER_KINDS = ["purchase", "investment", "loan_repayment", "friend_transfer", "transfer", "card_payment"] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

/// What a word the owner (or the page) uses for a kind means; null = not a kind he can set.
export function ownerKind(value: unknown): OwnerKind | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (v === "spending") return "purchase";
	if (v === "own_transfer") return "transfer";
	return (OWNER_KINDS as readonly string[]).includes(v) ? (v as OwnerKind) : null;
}

/// Money-out kinds that are never spending and that only the owner's word sets.
export const OWNER_ONLY_KINDS: ReadonlySet<LineKind> = new Set(["investment", "loan_repayment", "friend_transfer"]);

/// The kinds a payee rule may move a line between. Fees, rebates and a line
/// whose income the owner already said offsets something are left as they are.
const MOVABLE: ReadonlySet<LineKind> = new Set(["purchase", "refund", "income", "transfer", "card_payment", "investment", "loan_repayment", "friend_transfer"]);

/// The non-spending money the owner sees totalled in the month (overview `non_spending`), in this order.
export const NON_SPENDING_KINDS = ["investment", "loan_repayment", "friend_transfer", "transfer", "card_payment"] as const;

export interface PayeeRule {
	merchant_key: string;
	category: string | null;
	kind: OwnerKind | null;
	set_by: string;
	updated_at: string;
	/// migration 0007: 1 = the owner made it from a card line, so it also covers card
	/// lines with EXACTLY this merchant name. Absent / 0 = transfer lines only.
	card_lines?: 0 | 1;
}

// ------------------------------------------------- which lines a rule may touch

/// A bank prints these on money that left by a transfer (PayNow, FAST, GIRO, …).
const TRANSFER_WORDS = /\b(PAYNOW|PAY NOW|FAST PAYMENT|FAST TRANSFER|GIRO|IBG|TRANSFER|TRF|REMITTANCE|INTERBANK)\b|轉帳|匯款/;
/// …and these on a card payment taken from the account (debit card, NETS, a wallet).
const CARD_WORDS = /\b(DEBIT CARD|VISA|MASTERCARD|MASTER CARD|NETS|POS|EFTPOS|APPLE PAY|GOOGLE PAY|CONTACTLESS|CARD PURCHASE)\b/;
/// Kinds (or a reader's kind hints) that only money moved by transfer has.
const TRANSFER_KINDS: ReadonlySet<string> = new Set(["transfer", "payment", "income", "card_payment", "investment", "loan_repayment", "friend_transfer"]);

/// Is this line money moved by transfer (PayNow, a bank transfer, FAST) —
/// the only lines the owner's payee rules are about? A credit card or cash line
/// never is. A bank-account line is, unless it reads as a card payment; a
/// debit card / wallet line only when it reads as a transfer.
export function isTransferLine(accountKind: AccountKind | null | undefined, merchantRaw: string | null | undefined, kindOrHint: string | null | undefined): boolean {
	if (accountKind !== "bank" && accountKind !== "debit_card") return false;
	const raw = (merchantRaw ?? "").toUpperCase();
	if (CARD_WORDS.test(raw)) return false;
	if (TRANSFER_WORDS.test(raw) || (kindOrHint && TRANSFER_KINDS.has(kindOrHint))) return true;
	return accountKind === "bank";
}

/// The rule covering one line: by the payee's words on a transfer line
/// (ruleFor); on any other line only a rule the owner made from a card line, with
/// exactly this merchant name. So a shop whose name STARTS like a friend's
/// ("BELLA BOUTIQUE" against the rule "BELLA") is never a friend transfer.
export function ruleForLine<R extends Pick<PayeeRule, "merchant_key"> & { card_lines?: number | null }>(key: string | null | undefined, transfer: boolean, rules: readonly R[]): R | null {
	if (transfer) return ruleFor(key, rules);
	if (!key) return null;
	const k = words(key.toUpperCase()).join(" ");
	return rules.find((r) => r.card_lines === 1 && words(r.merchant_key.toUpperCase()).join(" ") === k) ?? null;
}

const words = (key: string): string[] => key.split(" ").filter(Boolean);

function startsWith(line: readonly string[], rule: readonly string[]): boolean {
	return rule.length > 0 && rule.length <= line.length && rule.every((w, i) => line[i] === w);
}

/// One word of a masked name fits a real one: same length, every letter
/// shown is the same, at least one letter shown and at least one masked.
function maskedFits(shown: string, real: string): boolean {
	if (shown.length !== real.length || !shown.includes("X")) return false;
	let seen = 0;
	for (let i = 0; i < shown.length; i++) {
		if (shown[i] === "X") continue;
		if (shown[i] !== real[i]) return false;
		seen++;
	}
	return seen > 0;
}

/// Some word of this masked prefix really is masked (an X where the name has another letter).
function maskedStart(line: readonly string[], rule: readonly string[]): boolean {
	if (rule.length > line.length) return false;
	let masked = false;
	for (let i = 0; i < rule.length; i++) {
		if (line[i] === rule[i]) continue;
		if (!maskedFits(line[i]!, rule[i]!)) return false;
		masked = true;
	}
	return masked;
}

/// The rule covering a merchant key, or null.
export function ruleFor<R extends Pick<PayeeRule, "merchant_key">>(key: string | null | undefined, rules: readonly R[]): R | null {
	if (!key) return null;
	const line = words(key.toUpperCase());
	let best: R | null = null;
	let bestLen = 0;
	for (const r of rules) {
		const w = words(r.merchant_key.toUpperCase());
		if (startsWith(line, w) && w.length > bestLen) {
			best = r;
			bestLen = w.length;
		}
	}
	if (best) return best;
	const masked = rules.filter((r) => maskedStart(line, words(r.merchant_key.toUpperCase())));
	return masked.length === 1 ? masked[0]! : null;
}

/// The kind a line takes under the owner's kind: spending keeps a purchase a
/// purchase (money back = a refund); everything else is that kind outright.
/// null = no change (already that kind, or a line no rule moves).
export function kindUnder(line: Pick<LineRow, "kind" | "bill_minor"> & { income_offset?: string | null }, want: OwnerKind): LineKind | null {
	if (!MOVABLE.has(line.kind) || line.income_offset) return null;
	if (want === "purchase") {
		if (line.kind === "purchase" || line.kind === "refund") return null;
		return line.bill_minor < 0 ? "refund" : "purchase";
	}
	return line.kind === want ? null : want;
}

/// What a rule changes on a line (kind and/or category), or {} for nothing.
/// `keepCategory`: the line's category is the owner's own pick — leave it.
export function ruleChanges(line: Pick<LineRow, "kind" | "bill_minor" | "category"> & { income_offset?: string | null }, rule: Pick<PayeeRule, "kind" | "category">, keepCategory = false): Partial<LineRow> {
	const out: Partial<LineRow> = {};
	if (rule.kind) {
		const k = kindUnder(line, rule.kind);
		if (k) out.kind = k;
	}
	const spending = (out.kind ?? line.kind) === "purchase" || (out.kind ?? line.kind) === "refund";
	if (rule.category && spending && !keepCategory && line.category !== rule.category) out.category = rule.category;
	return out;
}

/// Matching (src/matching.ts): a line the owner re-kinded still takes the alert or
/// statement line that reads it as an ordinary payment.
export function kindsMatch(lineKind: LineKind, inputKind: LineKind): boolean {
	if (lineKind === inputKind) return true;
	// Either way round: a line filed before the owner's rule existed (the look back
	// has not reached it yet) still takes the statement line read under it.
	return (OWNER_ONLY_KINDS.has(lineKind) && MOVABLE.has(inputKind)) || (OWNER_ONLY_KINDS.has(inputKind) && MOVABLE.has(lineKind));
}
