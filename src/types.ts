/// The shapes every part of the ledger agrees on. Persisted rows use the exact
/// column names of migrations/0001_ledger.sql (snake_case), so a row read from
/// D1 IS one of these objects — there is no mapping layer to drift.
/// test/schema.test.ts fails if a field here and a column there disagree.
///
/// Enums live here, not in CHECK constraints: SQLite cannot widen a CHECK
/// without rebuilding the table, and these lists will grow.

/// 'wallet' (14 Oct 2026): a stored-value wallet — GrabPay. It holds
/// money the owner topped up (a transfer from his own account, never spending) and
/// pays for things out of it; it has a running balance (src/wallet.ts).
export const ACCOUNT_KINDS = ["credit_card", "debit_card", "bank", "cash", "wallet"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/// investment / loan_repayment / friend_transfer (round 2): money out that the owner
/// said is not spending — set only by his word (src/payees.ts), never detected.
/// wallet_offset (14 Oct 2026): the ledger's own counter-line for a
/// wallet purchase paid with money that was ALREADY counted as spending when it
/// was topped up (src/wallet.ts). Negative, in the old top-ups' category, so the
/// purchase shows in its real category without being counted twice. Never
/// evidence-backed, never matched, never on a statement, never the owner's to edit.
export const LINE_KINDS = ["purchase", "refund", "fee", "rebate", "income", "transfer", "card_payment", "investment", "loan_repayment", "friend_transfer", "wallet_offset"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/// Kinds that count as spending. A refund counts NEGATIVE (it carries a negative
/// amount). Transfers, card payments, income and rebates never count.
export const SPENDING_KINDS: ReadonlySet<LineKind> = new Set(["purchase", "fee", "refund", "wallet_offset"]);

export const LINE_STATES = ["open", "posted", "reconciled", "review", "void"] as const;
export type LineState = (typeof LINE_STATES)[number];

export const BILL_STATUSES = ["exact", "estimate", "confirmed"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/// 'reference' = converted to SGD at the reference rate because the account is
/// not in SGD (台新 TWD, foreign cash). Shown to the owner as an estimate; no
/// statement will ever confirm it — only the owner can.
export const HOME_STATUSES = ["exact", "estimate", "confirmed", "reference"] as const;
export type HomeStatus = (typeof HOME_STATUSES)[number];

export const ACTORS = ["rules", "daily", "senior", "owner"] as const;
export type Actor = (typeof ACTORS)[number];

/// 'apple_pay_shortcut' = the owner's iPhone Shortcuts "Transaction" automation,
/// posting each Apple Pay tap (src/shortcut.ts). Matched exactly like a bank
/// alert, and provisional until a statement confirms it.
/// 'sms' (migration 0013) = a prepaid shop's SMS after a use, sent on by
/// The owner's iPhone Shortcut and read by the reading desk (src/wallet-sms.ts).
export const EVIDENCE_TYPES = ["alert", "apple_pay_shortcut", "receipt", "statement_line", "manual", "sms"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const KIND_HINTS = [
	"purchase",
	"refund",
	"fee",
	"fx_fee",
	"rebate",
	"income",
	"transfer",
	"payment",
	"atm",
] as const;
export type KindHint = (typeof KIND_HINTS)[number];

export const RECON_STATUSES = ["pending", "reconciled", "escalated"] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

export type MarkupSource = "learned" | "bank_default";

export interface Account {
	id: string;
	institution: string;
	kind: AccountKind;
	name: string;
	last4: string | null;
	currency: string;
	settles_to: string | null;
	alerts_expected: 0 | 1;
	has_statements: 0 | 1;
	active: 0 | 1;
	created_at: string;
	/// migration 0004 (C): the card's cut-off and due day; who set them.
	statement_day?: number | null;
	due_day?: number | null;
	settings_source?: "owner" | "statement" | null;
	/// migration 0007: the card that replaced this one (a lost card); the two are one card going forward.
	replaced_by?: string | null;
	/// migration 0010 (a wallet only): recorded from this date; its balance at the
	/// start of that day; how much of that balance was already counted as spending
	/// (in the old top-ups) and in which category. NULL on every other account.
	wallet_since?: string | null;
	wallet_opening_minor?: number | null;
	wallet_precounted_minor?: number | null;
	wallet_precounted_category?: string | null;
	/// migration 0012 (a wallet only): its own top-up rule — a card or bank line
	/// whose merchant contains this text is money into the wallet; 1 = only a
	/// whole number of dollars. NULL on GrabPay (its rule is in code) and every
	/// other account.
	wallet_topup_merchant?: string | null;
	wallet_topup_whole_dollars?: number | null;
	/// migration 0012: the category a wallet purchase the owner tells takes when he names none.
	wallet_spend_category?: string | null;
	/// migration 0013 (a wallet only): which SMS belong to it — words the SMS
	/// contains (comma-separated, any one) and the sender the owner's Shortcut names.
	/// Both NULL = the wallet takes no SMS (src/wallet-sms.ts).
	wallet_sms_keywords?: string | null;
	wallet_sms_sender?: string | null;
	/// migration 0013: what the owner paid for the opening credit (NULL = the opening
	/// balance itself: no bonus) — the opening lot's ratio (src/wallet.ts planCosts).
	wallet_opening_paid_minor?: number | null;
	/// migration 0013: the shop's usual top-up bonus, "pay 300 get 350" = 30000 /
	/// 35000: the credit an automatic top-up gets by default. NULL = none known
	/// (待確認 asks 「這次儲值有送嗎？」).
	wallet_topup_deal_paid_minor?: number | null;
	wallet_topup_deal_credit_minor?: number | null;
	/// migration 0011: the owner's word on how this card is paid — 1 auto-debit, 0 he
	/// pays it himself; NULL = the ledger decides from its statements.
	autopay?: number | null;
}

export interface LineRow {
	id: string;
	account_id: string;
	kind: LineKind;
	state: LineState;
	txn_date: string;
	post_date: string | null;
	merchant_raw: string | null;
	merchant_key: string | null;
	merchant_name: string | null;
	merchant_country: string | null;
	category: string | null;
	orig_currency: string;
	orig_minor: number;
	bill_currency: string;
	bill_minor: number;
	bill_status: BillStatus;
	fee_minor: number;
	market_rate: number | null;
	markup: number | null;
	markup_source: MarkupSource | null;
	effective_rate: number | null;
	observed_markup: number | null;
	home_minor: number;
	home_status: HomeStatus;
	home_rate: number | null;
	home_set_by: "rules" | "owner";
	statement_id: string | null;
	refund_of: string | null;
	transfer_group: string | null;
	merged_into: string | null;
	reimbursable_override: 0 | 1 | null;
	flag_missed_by_alerts: 0 | 1;
	flag_not_on_statement: 0 | 1;
	flag_unlinked_refund: 0 | 1;
	/// What the owner said an incoming payment offsets (migration 0004); absent/NULL = not set.
	income_offset?: "salary" | "card" | "line" | null;
	/// The account an offset counts against (the card, or the paid-back purchase's account).
	offset_account_id?: string | null;
	flag_no_rate: 0 | 1;
	note: string | null;
	created_by: Actor;
	created_at: string;
	updated_at: string;
	/// migration 0004: the own account a card_payment / transfer moves money to or from.
	counter_account_id?: string | null;
	/// migration 0007: flags the owner looked at and said are fine (comma-separated) — never raised on this line again.
	owner_ok?: string | null;
	/// migration 0010: a wallet_offset line names the wallet purchase it offsets.
	offset_of?: string | null;
}

/// Travel facts a receipt can carry (in details_json.travel). Filled by the
/// per-sender pattern or by the daily model; read by src/trips.ts.
export interface FlightLeg {
	from: string; // IATA airport, e.g. "SIN"
	from_country: string; // ISO alpha-2 of the departure airport
	to: string;
	date: string; // departure date, local
	to_country: string; // ISO alpha-2 of the arrival airport
	to_city?: string;
}
export interface HotelStay {
	city: string;
	country: string; // ISO alpha-2
	check_in: string;
	check_out: string;
}

/// details_json — every key optional; parsers fill what the source states.
export interface EvidenceDetails {
	seq?: number; // position on a statement (fee lines attach to the line before)
	order_id?: string;
	sender_domain?: string;
	counterparty?: { last4?: string; institution?: string; name?: string };
	travel?: { flights?: FlightLeg[]; hotels?: HotelStay[] };
	items?: string[];
}

export interface Evidence {
	id: string;
	type: EvidenceType;
	line_id: string | null;
	message_id: string | null;
	statement_id: string | null;
	fingerprint: string;
	institution: string | null;
	last4: string | null;
	txn_date: string;
	txn_time: string | null;
	post_date: string | null;
	currency: string;
	amount_minor: number; // signed: + money out / debt up
	bill_currency: string | null;
	bill_minor: number | null;
	merchant_raw: string | null;
	merchant_country: string | null;
	kind_hint: KindHint | null;
	details_json: string | null;
	created_at: string;
	/// migration 0004: the owner dismissed this held item (never deleted).
	dismissed_at?: string | null;
	dismiss_reason?: string | null;
}

export interface Statement {
	id: string;
	account_id: string;
	period_start: string;
	period_end: string;
	currency: string;
	opening_balance_minor: number | null;
	closing_balance_minor: number | null;
	printed_net_minor: number | null;
	message_id: string | null;
	attachment_name: string | null;
	recon_status: ReconStatus;
	recon_checked_at: string | null;
	recon_detail_json: string | null;
	created_at: string;
	/// migration 0004 (D, 6.): the bill as printed, and the bill-group split.
	previous_balance_minor?: number | null;
	statement_balance_minor?: number | null;
	minimum_due_minor?: number | null;
	payments_credited_minor?: number | null;
	due_date?: string | null;
	bill_group?: string | null;
	bill_primary?: 0 | 1;
	bill_check?: "ok" | "mismatch" | null;
	bill_detail_json?: string | null;
	reviewed_at?: string | null;
	/// migration 0011: the owner said 「我已繳款」 on this bill (when); the bill the next
	/// statement shows unpaid, seen by the owner in 待確認 (when).
	paid_by_owner_at?: string | null;
	unpaid_seen_at?: string | null;
}

export function isLineKind(value: unknown): value is LineKind {
	return typeof value === "string" && (LINE_KINDS as readonly string[]).includes(value);
}
