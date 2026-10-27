/// A prepaid shop's SMS after each use (19 Oct 2026 — the owner's second
/// restaurant card). His iPhone Shortcut sends the text on
/// (worker/src/sms.ts, POST /api/shortcut/sms); the reading desk reads it like
/// an email; here the reading becomes the wallet's spend, and the balance the
/// SMS states is checked against the ledger's.
///
/// The text is UNTRUSTED. It can only ever touch the one wallet whose words it
/// carries (src/wallet.ts smsWallet — data on the wallet's row, migration
/// 0013): never a bank or a card, never a new account. The same SMS sent twice
/// within a minute is recorded once (its fingerprint).
///
/// What the owner sees: the spend as a line of its own (or joined to the one he
/// already told), and — when the SMS's balance and the ledger's differ — a
/// 待確認 item 「<wallet> 簡訊餘額 X，帳本算出 Y」 with two answers: take the
/// SMS's balance (one adjustment line) or "I'll check" (nothing changes).

import type { Db } from "./db";
import { addWalletAdjustment, addWalletSmsSpend, getLine, loadAccounts, type Engine } from "./engine";
import { formatMoney, parsePrinted } from "./money";
import { Refused } from "./refused";
import type { Account } from "./types";
import { creditText, isWallet, smsDate, takesSms, type WalletAccount } from "./wallet";
import { homeCurrency } from "./home";
import { say, sayMoney } from "./words";

export { smsDate };

export interface WalletSmsRow {
	id: string;
	fingerprint: string;
	account_id: string;
	sender: string | null;
	text: string;
	received_at: string;
	/// The day of the use: the Shortcut's "date", else the owner's day it arrived.
	sms_date: string;
	state: "reading" | "done" | "not_spend" | "failed" | "dismissed";
	spent_minor: number | null;
	balance_minor: number | null;
	line_id: string | null;
	ledger_balance_minor: number | null;
	check_state: "ok" | "mismatch" | "accepted" | "checked" | null;
	adjust_line_id: string | null;
	error: string | null;
	updated_at: string;
}

/// The longest SMS text taken (a shop's SMS is a few hundred characters).
export const MAX_SMS_CHARS = 2000;

/// Spaces folded, case kept: the same SMS sent twice reads the same.
export function normaliseSms(text: string): string {
	return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

async function sha256Hex(text: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// The SMS's fingerprint: its text and the minute it arrived (ISO, to the minute).
export async function smsFingerprint(text: string, minute: string): Promise<string> {
	return sha256Hex(`${normaliseSms(text)}|${minute.slice(0, 16)}`);
}

/// The wallet's balance (credit) right after this SMS: the opening balance,
/// less every money move up to the end of the day before, and on the day
/// itself the moves already in the ledger when the SMS arrived plus the SMS's
/// own line — not a later meal the owner told before the reading was done.
export async function balanceAtSms(db: Db, wallet: WalletAccount, date: string, receivedAt: string, lineId: string | null): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COALESCE(SUM(bill_minor), 0) AS moved FROM lines WHERE account_id = ? AND state <> 'void' AND merged_into IS NULL AND kind <> 'wallet_offset' AND txn_date >= ? " +
				"AND (txn_date < ? OR (txn_date = ? AND (created_at <= ? OR id = ?)))",
		)
		.bind(wallet.id, wallet.wallet_since, date, date, receivedAt, lineId)
		.first<{ moved: number }>();
	return (wallet.wallet_opening_minor ?? 0) - (row?.moved ?? 0);
}

// ------------------------------------------------------------- the built-in reader

/// The labels a shop's SMS puts before the amount used and the balance left
/// (範例 via RestoSuite: 「消费卡值: $31.40,卡余额:$257.48」), simplified and
/// traditional Chinese and English. The longer label first: 「卡余额」 before 「余额」.
const SPENT_LABELS = ["消费卡值", "消費卡值", "消费金额", "消費金額", "扣款金额", "扣款金額", "消费", "消費", "扣款", "Amount Deducted", "Deducted", "Spent"];
const BALANCE_LABELS = ["卡余额", "卡餘額", "余额", "餘額", "Remaining Balance", "Card Balance", "Balance"];
/// An amount after its label: an optional ":", an optional currency mark (a
/// symbol — "$", "S$", "€", "¥" — or the wallet's OWN currency code; any other
/// word after the label is not money, and the reading desk reads that SMS), then
/// the figure in any locale's print — "1,031.40", "1.012,50", "12,50" (src/money.ts
/// parsePrinted reads it). A separator groups thousands only before exactly three
/// digits, so "31.40,卡余额" ends at 40 and "10.00,20.00" is two figures, never one.
const amountAfter = (code: string) =>
	String.raw`\s*[:]?\s*(?:${code}|[A-Z]{0,2}[$€£¥₩฿₹])?\s*(\d{1,3}(?:[,.'\u00A0\u202F ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const labelled = (labels: readonly string[], code: string) => new RegExp(`(?:${labels.map(escapeRe).join("|")})${amountAfter(escapeRe(code))}`, "gi");

/// The SMS read by code, when it is a format the ledger knows: exactly one
/// amount used and exactly one balance, each after its label. Full-width
/// colons, commas and dollar signs count as their ASCII selves (NFKC). Anything
/// else — no label, two of either, a top-up notice — is null, and the reading
/// desk reads it instead. Never a guess.
export function parseSmsLocally(text: string, currency: string): SmsReading | null {
	const t = text.normalize("NFKC");
	const spent = [...t.matchAll(labelled(SPENT_LABELS, currency))];
	const left = [...t.matchAll(labelled(BALANCE_LABELS, currency))];
	if (spent.length !== 1 || left.length !== 1) return null;
	// The two must be different figures in the text (a label inside another never doubles up).
	if (spent[0]!.index === left[0]!.index) return null;
	try {
		const spentMinor = parsePrinted(spent[0]![1]!, currency);
		const balanceMinor = parsePrinted(left[0]![1]!, currency);
		if (spentMinor <= 0) return null;
		return { kind: "spend", spent_minor: spentMinor, balance_minor: balanceMinor };
	} catch {
		return null;
	}
}

/// What the reading desk reported of one SMS (amounts already in minor units).
export interface SmsReading {
	kind: "spend" | "topup" | "other";
	spent_minor: number | null;
	balance_minor: number | null;
}

const at = (e: Engine) => e.now();

/// One reading becomes the wallet's spend and its balance check. Safe to
/// repeat: a row already read is left as it is.
export async function applySmsReading(e: Engine, row: WalletSmsRow, reading: SmsReading, category: string | null): Promise<WalletSmsRow> {
	if (row.state !== "reading") return row;
	const accounts = await loadAccounts(e.db);
	const wallet = accounts.find((a) => a.id === row.account_id);
	if (!isWallet(wallet) || !takesSms(wallet) || wallet.active !== 1) return failSms(e, row, "this wallet no longer takes SMS");
	const date = row.sms_date;
	if (reading.kind !== "spend" || !reading.spent_minor || reading.spent_minor <= 0) {
		// A top-up notice, an advert: nothing recorded (a top-up comes from his card's own line).
		await e.db
			.prepare("UPDATE wallet_sms SET state = 'not_spend', text = '', balance_minor = ?, updated_at = ? WHERE id = ? AND state = 'reading'")
			.bind(reading.balance_minor, at(e), row.id)
			.run();
		return (await smsRow(e.db, row.id))!;
	}
	let lineId: string;
	try {
		const r = await addWalletSmsSpend(
			e,
			wallet,
			{ txn_date: date, currency: wallet.currency, amount_minor: reading.spent_minor, merchant: wallet.name, category, note: say("sms.line_note", { name: wallet.name }) },
			`sms|${row.id}`,
		);
		lineId = r.line.id;
	} catch (err) {
		if (err instanceof Refused) return failSms(e, row, err.message);
		throw err;
	}
	let ledger: number | null = null;
	let check: WalletSmsRow["check_state"] = null;
	if (reading.balance_minor !== null) {
		ledger = await balanceAtSms(e.db, wallet, date, row.received_at, lineId);
		check = ledger === reading.balance_minor ? "ok" : "mismatch";
	}
	await e.db
		.prepare(
			"UPDATE wallet_sms SET state = 'done', text = '', spent_minor = ?, balance_minor = ?, line_id = ?, ledger_balance_minor = ?, check_state = ?, error = NULL, updated_at = ? WHERE id = ? AND state = 'reading'",
		)
		.bind(reading.spent_minor, reading.balance_minor, lineId, ledger, check, at(e), row.id)
		.run();
	return (await smsRow(e.db, row.id))!;
}

/// An SMS that could not be read or recorded: 待確認 tells the owner to record it himself.
export async function failSms(e: Engine, row: WalletSmsRow, why: string): Promise<WalletSmsRow> {
	await e.db.prepare("UPDATE wallet_sms SET state = 'failed', error = ?, updated_at = ? WHERE id = ? AND state = 'reading'").bind(why.slice(0, 300), at(e), row.id).run();
	return (await smsRow(e.db, row.id))!;
}

export async function smsRow(db: Db, id: string): Promise<WalletSmsRow | null> {
	return db.prepare("SELECT * FROM wallet_sms WHERE id = ?").bind(id).first<WalletSmsRow>();
}

/// The short answer (in the owner's language) the Shortcut shows for an SMS already handled.
export async function smsReply(db: Db, row: WalletSmsRow, wallet: Pick<Account, "name" | "currency">): Promise<string> {
	if (row.state === "reading") return say("sms.reading");
	if (row.state === "done" && row.spent_minor !== null) {
		const line = row.line_id ? await getLine(db, row.line_id) : null;
		const cost = line && line.home_minor !== row.spent_minor ? say("sms.real_cost", { cost: formatMoney(line.home_minor, homeCurrency()) }) : "";
		const left = row.balance_minor !== null ? say("sms.balance_left", { balance: creditText(row.balance_minor) }) : "";
		return say("sms.recorded", { name: wallet.name, amount: sayMoney(row.spent_minor, wallet.currency), cost, left });
	}
	if (row.state === "not_spend") return say("sms.not_spend", { name: wallet.name });
	if (row.state === "failed") return say("sms.unreadable", { name: wallet.name });
	return say("sms.received");
}

/// The owner's answer to a balance mismatch: take the SMS's balance (one adjustment
/// line) or look himself (nothing changes). Either way it leaves 待確認.
export async function answerSmsCheck(e: Engine, smsId: string, answer: "accept" | "checked", category: string | null): Promise<{ row: WalletSmsRow; line_id: string | null; message: string }> {
	const row = await smsRow(e.db, smsId);
	if (!row) throw new Refused("no such SMS");
	if (row.check_state !== "mismatch" || row.balance_minor === null || row.ledger_balance_minor === null) throw new Refused(say("sms.check_done"));
	const wallet = (await loadAccounts(e.db)).find((a) => a.id === row.account_id);
	if (!isWallet(wallet)) throw new Refused("that wallet is gone");
	if (answer === "checked") {
		await e.db.prepare("UPDATE wallet_sms SET check_state = 'checked', updated_at = ? WHERE id = ? AND check_state = 'mismatch'").bind(at(e), row.id).run();
		return { row: (await smsRow(e.db, row.id))!, line_id: null, message: say("sms.check_yourself") };
	}
	// Claim it first: two taps make one adjustment.
	const claimed = await e.db.prepare("UPDATE wallet_sms SET check_state = 'accepted', updated_at = ? WHERE id = ? AND check_state = 'mismatch'").bind(at(e), row.id).run();
	if (!claimed.meta.changes) throw new Refused(say("sms.check_done"));
	// Measured again now: lines changed since the check move what is needed.
	const date = row.sms_date;
	const ledger = await balanceAtSms(e.db, wallet, date, row.received_at, row.line_id);
	const out = ledger - row.balance_minor;
	if (out === 0) return { row: (await smsRow(e.db, row.id))!, line_id: null, message: say("sms.check_same") };
	const note = say("sms.adjust_note", { name: wallet.name, balance: creditText(row.balance_minor), ledger: creditText(ledger) });
	const line = await addWalletAdjustment(e, wallet, date, out, note, category);
	await e.db.prepare("UPDATE wallet_sms SET adjust_line_id = ?, updated_at = ? WHERE id = ?").bind(line.id, at(e), row.id).run();
	return { row: (await smsRow(e.db, row.id))!, line_id: line.id, message: say("sms.adjusted", { name: wallet.name, balance: creditText(row.balance_minor) }) };
}

/// The owner's "I'll record it myself" on an SMS that could not be read.
export async function dismissSms(e: Engine, smsId: string): Promise<void> {
	const r = await e.db.prepare("UPDATE wallet_sms SET state = 'dismissed', text = '', updated_at = ? WHERE id = ? AND state = 'failed'").bind(at(e), smsId).run();
	if (!r.meta.changes) throw new Refused(say("sms.nothing_to_do"));
}
