/// MADE-UP accounts and lines for tests. No real card number, merchant history
/// or amount of the owner's appears in any test — the last-4s here are invented.

import type { Account, Evidence, LineRow, Statement } from "../../src/types";

const T0 = "2026-01-01T00:00:00.000Z";

export function account(a: Partial<Account> & Pick<Account, "id" | "institution" | "kind" | "currency">): Account {
	return {
		name: a.id,
		last4: null,
		settles_to: null,
		alerts_expected: 1,
		has_statements: 1,
		active: 1,
		created_at: T0,
		statement_day: null,
		due_day: null,
		settings_source: null,
		replaced_by: null,
		wallet_since: null,
		wallet_opening_minor: null,
		wallet_precounted_minor: null,
		wallet_precounted_category: null,
		wallet_topup_merchant: null,
		wallet_topup_whole_dollars: null,
		wallet_spend_category: null,
		wallet_sms_keywords: null,
		wallet_sms_sender: null,
		wallet_opening_paid_minor: null,
		wallet_topup_deal_paid_minor: null,
		wallet_topup_deal_credit_minor: null,
		autopay: null,
		...a,
	};
}

export const BANK = account({ id: "bank-x", institution: "dbs", kind: "bank", currency: "SGD", last4: "9001" });
export const DEBIT = account({ id: "debit-x", institution: "dbs", kind: "debit_card", currency: "SGD", last4: "9002", settles_to: "bank-x", has_statements: 0 });
export const CARD_A = account({ id: "card-a", institution: "hsbc", kind: "credit_card", currency: "SGD", last4: "1111" });
export const CARD_B = account({ id: "card-b", institution: "hsbc", kind: "credit_card", currency: "SGD", last4: "2222" });
export const CARD_C = account({ id: "card-c", institution: "citi", kind: "credit_card", currency: "SGD", last4: "3333" });
export const CARD_T = account({ id: "card-t", institution: "taishin", kind: "credit_card", currency: "TWD", last4: "4444" });
export const CASH = account({ id: "cash", institution: "cash", kind: "cash", currency: "SGD", alerts_expected: 0, has_statements: 0 });
export const ACCOUNTS: readonly Account[] = [BANK, DEBIT, CARD_A, CARD_B, CARD_C, CARD_T, CASH];
/// A GrabPay-like wallet (made-up figures): recorded from 2026-10-14 with S$42.00
/// in it, all of it already counted as spending when it was topped up.
export const WALLET = account({
	id: "wallet-g",
	institution: "grab",
	kind: "wallet",
	currency: "SGD",
	alerts_expected: 0,
	has_statements: 1,
	wallet_since: "2026-10-14",
	wallet_opening_minor: 4200,
	wallet_precounted_minor: 4200,
	wallet_precounted_category: "Grab/Uber",
});
/// A prepaid stored-value card like the owner's Sample Bistro one (migration 0012):
/// recorded from 2026-10-19 with nothing in it, nothing pre-counted, no
/// statements or mail; its own top-up rule is data on the row.
export const PREPAID = account({
	id: "wallet-hg",
	institution: "sample-bistro",
	kind: "wallet",
	currency: "SGD",
	name: "Sample Bistro 儲值卡",
	alerts_expected: 0,
	has_statements: 0,
	wallet_since: "2026-10-19",
	wallet_opening_minor: 0,
	wallet_precounted_minor: 0,
	wallet_topup_merchant: "SAMPLE BISTRO",
	wallet_topup_whole_dollars: 1,
	wallet_spend_category: "Food",
});

/// A made-up 範例 card (the migration 0013 columns): texted by
/// RestoSuite after each use; deal pay 300 get 350; 288.88 credit at the start of
/// 2026-10-18, which cost 288.88 × 300 ÷ 350 = 247.6114… → S$247.61, all of it
/// pre-counted (earlier card top-ups were Food spending).
export const DEMO = account({
	id: "wallet-xx",
	institution: "demo-noodle",
	kind: "wallet",
	currency: "SGD",
	name: "範例 儲值卡",
	alerts_expected: 0,
	has_statements: 0,
	wallet_since: "2026-10-18",
	wallet_opening_minor: 28888,
	wallet_opening_paid_minor: 24761,
	wallet_precounted_minor: 24761,
	wallet_precounted_category: "Food",
	wallet_topup_merchant: "DEMO NOODLE HOUSE,RESTOSUITE,範例",
	wallet_topup_whole_dollars: 1,
	wallet_spend_category: "Food",
	wallet_sms_keywords: "DEMO NOODLE,範例",
	wallet_sms_sender: "RestoSuite",
	wallet_topup_deal_paid_minor: 30000,
	wallet_topup_deal_credit_minor: 35000,
});
/// A made-up SMS in RestoSuite's format, dated 2026-10-18.
export const DEMO_SMS = "【DEMO NOODLE】您的卡*5509在範例麵館 @ 101,消费卡值: $31.40,卡余额:$257.48";

let n = 0;
export function line(over: Partial<LineRow> = {}): LineRow {
	n++;
	const id = over.id ?? `L${String(n).padStart(3, "0")}`;
	return {
		id,
		account_id: CARD_A.id,
		kind: "purchase",
		state: "open",
		txn_date: "2026-03-05",
		post_date: null,
		merchant_raw: "TEST MERCHANT",
		merchant_key: "TEST MERCHANT",
		merchant_name: "Test Merchant",
		merchant_country: null,
		category: null,
		orig_currency: "SGD",
		orig_minor: 1000,
		bill_currency: "SGD",
		bill_minor: 1000,
		bill_status: "exact",
		fee_minor: 0,
		market_rate: null,
		markup: null,
		markup_source: null,
		effective_rate: null,
		observed_markup: null,
		home_minor: over.bill_minor ?? 1000,
		home_status: "exact",
		home_rate: null,
		home_set_by: "rules",
		statement_id: null,
		refund_of: null,
		transfer_group: null,
		merged_into: null,
		reimbursable_override: null,
		flag_missed_by_alerts: 0,
		flag_not_on_statement: 0,
		flag_unlinked_refund: 0,
		income_offset: null,
		offset_account_id: null,
		flag_no_rate: 0,
		note: null,
		created_by: "rules",
		created_at: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.${String(n).padStart(3, "0").slice(-3)}Z`,
		updated_at: T0,
		counter_account_id: null,
		owner_ok: null,
		offset_of: null,
		...over,
	};
}

export function evidence(over: Partial<Evidence> = {}): Evidence {
	n++;
	return {
		id: `E${String(n).padStart(3, "0")}`,
		type: "statement_line",
		line_id: null,
		message_id: null,
		statement_id: null,
		fingerprint: `fp-${n}`,
		institution: null,
		last4: null,
		txn_date: "2026-03-05",
		txn_time: null,
		post_date: null,
		currency: "SGD",
		amount_minor: 1000,
		bill_currency: null,
		bill_minor: null,
		merchant_raw: null,
		merchant_country: null,
		kind_hint: null,
		details_json: null,
		created_at: T0,
		dismissed_at: null,
		dismiss_reason: null,
		...over,
	};
}

export function statement(over: Partial<Statement> & Pick<Statement, "id" | "account_id">): Statement {
	return {
		period_start: "2026-02-16",
		period_end: "2026-03-15",
		currency: "SGD",
		opening_balance_minor: null,
		closing_balance_minor: null,
		printed_net_minor: null,
		message_id: null,
		attachment_name: null,
		recon_status: "pending",
		recon_checked_at: null,
		recon_detail_json: null,
		created_at: T0,
		previous_balance_minor: null,
		statement_balance_minor: null,
		minimum_due_minor: null,
		payments_credited_minor: null,
		due_date: null,
		bill_group: null,
		bill_primary: 1,
		bill_check: null,
		bill_detail_json: null,
		reviewed_at: null,
		paid_by_owner_at: null,
		unpaid_seen_at: null,
		...over,
	};
}
