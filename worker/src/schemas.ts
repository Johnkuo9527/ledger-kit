/// The exact shapes Claude must answer in (structured outputs). Each maps
/// one-to-one onto an engine input (src/engine.ts EvidenceIn / StatementIn /
/// StatementLineIn), so nothing is guessed between the model and the ledger.
///
/// Amounts are STRINGS as printed ("1,234.50"), turned into integer minor
/// units by parseMajor() — never a float from the model. Dates are
/// YYYY-MM-DD. Every answer says how sure it is; "unsure" goes up to the
/// senior model instead of into the ledger.

import * as z from "zod/v4";
import { KIND_HINTS } from "../../src/types";

const date = z.string().describe("YYYY-MM-DD");
const amount = z.string().describe('the amount exactly as printed, without the currency, e.g. "1,234.50"; no sign');
const currency = z.string().describe("ISO 4217 code, e.g. SGD, USD, TWD, JPY");
const sure = z.enum(["sure", "unsure"]).describe('"unsure" whenever any field is a guess');

/// A bank alert email no playbook pattern fitted.
export const AlertSchema = z.object({
	is_transaction: z.boolean().describe("false for marketing, OTP codes, login notices — anything that is not money moving"),
	institution: z.enum(["dbs", "hsbc", "citi", "taishin", "other"]),
	last4: z.string().nullable().describe("last 4 digits of the card or account the money moved on"),
	currency,
	amount,
	direction: z.enum(["out", "in"]).describe('"out" = money leaving the owner / card debt growing; "in" = refund, credit, money received'),
	merchant: z.string().nullable(),
	country: z.string().nullable().describe("ISO 3166 alpha-2 if stated"),
	date,
	time: z.string().nullable().describe("HH:MM 24-hour if stated"),
	kind_hint: z.enum(KIND_HINTS),
	confidence: sure,
	note: z.string().describe("one short line: anything odd"),
});
export type AlertAnswer = z.infer<typeof AlertSchema>;

const Flight = z.object({ from: z.string(), from_country: z.string(), to: z.string(), to_country: z.string(), to_city: z.string().nullable(), date });
const Hotel = z.object({ city: z.string(), country: z.string(), check_in: date, check_out: date });

/// A receipt, invoice, order or booking confirmation.
export const ReceiptSchema = z.object({
	is_receipt: z.boolean().describe("false for adverts, shipping updates with no amount, newsletters"),
	merchant: z.string(),
	currency,
	amount: amount.describe("the TOTAL charged"),
	direction: z.enum(["out", "in"]).describe('"in" for a refund confirmation'),
	date: date.describe("the day the charge happened (order or payment date)"),
	order_id: z.string().nullable(),
	items: z.array(z.string()).describe("up to 5 short item names"),
	flights: z.array(Flight).describe("one entry per flight leg; empty if none"),
	hotels: z.array(Hotel).describe("one entry per stay; empty if none"),
	confidence: sure,
	note: z.string(),
});
export type ReceiptAnswer = z.infer<typeof ReceiptSchema>;

const StatementLine = z.object({
	seq: z.number().int().describe("position on the statement, from 1, in printed order"),
	date: date.describe("transaction date"),
	post_date: date.nullable(),
	description: z.string().describe("the merchant / description exactly as printed"),
	currency: currency.describe("the currency of `amount` — the foreign currency if the line prints one"),
	amount,
	bill_currency: currency.nullable().describe("when a foreign line ALSO prints the amount billed in the account's currency"),
	bill_amount: amount.nullable(),
	direction: z.enum(["out", "in"]).describe('"in" for CR / credit / payment received / refund'),
	country: z.string().nullable(),
	kind_hint: z.enum(KIND_HINTS).describe('"fx_fee" for an itemised overseas / foreign-currency fee; "payment" for a bill payment onto the card'),
	card_last4: z.string().nullable().describe("when one statement covers several cards: the last 4 digits of the card this line was charged on — printed on the line or in the card heading it sits under; null only when the statement covers one card"),
});

/// A card or bank statement's text, read from the unlocked PDF.
export const StatementSchema = z.object({
	institution: z.enum(["dbs", "hsbc", "citi", "taishin", "other"]),
	statements: z
		.array(
			z.object({
				last4: z.string().describe("the card or account this section belongs to"),
				period_start: date.describe("first day the statement covers (the day after the previous statement date if not printed)"),
				period_end: date.describe("the statement date"),
				currency,
				opening_balance: amount.nullable().describe("previous balance, as printed"),
				opening_is_credit: z.boolean().describe("true if the previous balance is printed as a credit (CR)"),
				closing_balance: amount.nullable().describe("new balance / closing balance, as printed"),
				closing_is_credit: z.boolean(),
				minimum_due: amount.nullable().describe("a card bill's minimum payment due, as printed; null if not printed"),
				due_date: date.nullable().describe("a card bill's payment due date; null if not printed"),
				payments_credited: amount.nullable().describe("a card bill's total of payments received since the previous statement (not refunds), as printed in its summary; null if not printed"),
				lines: z.array(StatementLine),
			}),
		)
		.describe("one entry per card or account in the PDF (one PDF may hold two cards). A card bill that lists several cards under ONE balance is ONE entry: its last4 is the card the bill is addressed to, and each line names its own card in card_last4"),
	confidence: sure,
	note: z.string(),
});
export type StatementAnswer = z.infer<typeof StatementSchema>;

/// The senior model's alert pattern for a sender it has read at least three
/// times (learn.ts). Kept only if it reproduces every one of its own readings.
export const PatternSchema = z.object({
	subject: z.string().nullable().describe("a JavaScript regex the subject must match, or null"),
	body: z.string().describe("a JavaScript regex (u flag) over the plain-text body with NAMED groups: amount (required); optional currency, last4, merchant, date, time, country"),
	kind_hint: z.enum(KIND_HINTS),
	default_currency: z.string().describe("3-letter code used when the alert prints none"),
	date_format: z.enum(["D MMM YYYY", "DD/MM/YYYY", "YYYY/MM/DD", "YYYY-MM-DD", "D MMM"]).describe("how the date group is printed"),
	credit: z.boolean().describe("true if this alert reports money coming back (refund, credit)"),
});
export type PatternAnswer = z.infer<typeof PatternSchema>;

/// The senior model's answer to the day's open escalations (escalate.ts).
export const EscalationSchema = z.object({
	resolutions: z.array(
		z.object({
			id: z.string().describe("the escalation id, exactly as given"),
			action: z.enum(["resolved", "note_for_owner", "reprocess"]).describe('"reprocess" = read that email again from the start (after your playbook edits)'),
			note: z.string().describe("one or two plain-English sentences; for note_for_owner this is what the owner reads"),
		}),
	),
	playbook_edits: z
		.object({
			add_senders: z.array(z.object({ kind: z.enum(["alerts", "receipts", "ignore"]), institution: z.string().nullable(), from: z.string() })),
			add_merchant_aliases: z.array(z.object({ pattern: z.string().describe('a prefix of the upper-cased raw text, or "/regex/"'), canonical: z.string() })),
			add_category_rules: z.array(z.object({ merchant_key: z.string(), category: z.string() })),
			add_own_names: z.array(z.string()),
			notes_append: z.string().nullable(),
		})
		.nullable(),
});
export type EscalationAnswer = z.infer<typeof EscalationSchema>;

/// After the backfill: the senior model's summary of two years of the owner's money (backfill.ts).
export const PlaybookSummarySchema = z.object({
	summary: z.string().describe("what you learned about the owner's accounts and habits, plain words, under 200 words"),
	categories: z.array(z.string()).describe("10 to 20 spending categories that fit the owner's actual spending"),
	category_rules: z.array(z.object({ merchant_key: z.string(), category: z.string() })),
	own_names: z.array(z.string()).describe("how the owner's own name appears on transfers"),
	judgement_notes: z.string().describe("guidance for the daily model"),
	escalate_when: z.array(z.string()),
});
export type PlaybookSummaryAnswer = z.infer<typeof PlaybookSummarySchema>;

/// Mail Gmail vouched for as Grab's own (14 Oct 2026): a Grab
/// e-receipt or the GrabPay Wallet transaction statement. Read as a "receipt"
/// reading task (its instructions travel with the email, read.ts grabPrompt).
/// What it may do is decided in code (read.ts grabFromAnswer): only the
/// GrabPay wallet's lines, never a bank's or a card's.
const GrabEntry = z.object({
	date: date.describe("the day of this order, ride or wallet movement"),
	time: z.string().nullable().describe("HH:MM 24-hour if printed"),
	description: z.string().describe("the restaurant, shop, ride or movement exactly as printed"),
	service: z
		.enum(["food", "drinks", "mart", "ride", "delivery", "payment", "topup", "transfer_out", "transfer_in", "refund", "reward", "other"])
		.describe('"drinks" = an order of drinks only (bubble tea, coffee, juice); "food" = a meal; "mart" = groceries; "ride" = GrabCar, taxi, bike; "delivery" = GrabExpress; "payment" = paying a shop with GrabPay; "topup" = money added to the GrabPay wallet; "transfer_out"/"transfer_in" = money sent to / received from a person; "refund" = money back; "reward" = cashback or rewards credited'),
	direction: z.enum(["out", "in"]).describe('"out" = money paid; "in" = a top-up, refund, reward or money received'),
	currency,
	amount: amount.describe("the TOTAL of this entry as printed"),
	paid_with: z.enum(["grabpay_wallet", "card", "cash", "other", "unknown"]).describe('how it was paid, as printed: "grabpay_wallet" only for GrabPay Wallet / GrabPay balance / GrabPay credits; "card" for a card (Visa, Mastercard, "ending 1234"); "unknown" if not printed'),
	card_last4: z.string().nullable().describe("for a card: its last 4 digits if printed"),
	order_id: z.string().nullable().describe("the booking or order id if printed"),
	items: z.array(z.string()).describe("up to 5 short item names; empty for a ride"),
});

export const GrabSchema = z.object({
	is_money: z.boolean().describe("false for adverts, promotions, newsletters, rating requests, sign-in notices — anything with no money moving"),
	document: z.enum(["receipt", "wallet_statement"]).describe('"receipt" = one order, ride or payment; "wallet_statement" = the GrabPay Wallet transaction statement listing wallet movements'),
	period_start: date.nullable().describe("wallet_statement: the first day it covers; null for a receipt"),
	period_end: date.nullable().describe("wallet_statement: the last day it covers; null for a receipt"),
	opening_balance: amount.nullable().describe("wallet_statement: the GrabPay balance at the start, as printed; null if not printed"),
	closing_balance: amount.nullable().describe("wallet_statement: the GrabPay balance at the end, as printed; null if not printed"),
	entries: z.array(GrabEntry).describe("receipt: exactly ONE entry, the total charged. wallet_statement: EVERY transaction line, in printed order"),
	confidence: sure,
	note: z.string().describe("one short line: anything odd"),
});
export type GrabAnswer = z.infer<typeof GrabSchema>;
