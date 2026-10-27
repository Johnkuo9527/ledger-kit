/// seed/accounts.json → validated Account rows and the SQL that inserts them.
/// The worker runs seedStatements() once against a FRESH database; the
/// statements are INSERT OR IGNORE, so running them twice changes nothing.

import { bankListProblems, BANKS_KEY, normaliseBanks, type BankEntry } from "./bank-list";
import { parseMajor } from "./money";
import { isIsoDate } from "./dates";
import { walletKey } from "./shortcut";
import { ACCOUNT_KINDS, type Account, type AccountKind } from "./types";

export interface SeedAccount {
	id: string;
	institution: string;
	kind: AccountKind;
	name: string;
	last4: string | null;
	todo?: string;
	currency: string;
	settles_to?: string;
	alerts_expected?: boolean;
	has_statements?: boolean;
	/// false for a card the owner no longer has (lost, replaced): its old statements
	/// still map to it, but coverage stops expecting new ones.
	active?: boolean;
	/// The card that replaced this one (migration 0007): one card going forward.
	replaced_by?: string;
	/// Card names exactly as Apple Wallet shows them (the shortcut reports these).
	wallet_names?: string[];
	/// A stored-value wallet only (kind "wallet", migration 0010): recorded from
	/// `since`; `opening_balance` in it at the start of that day; how much of it
	/// was already counted as spending (in the old top-ups), and in which category
	/// (may be empty when nothing was pre-counted). `topup` (migration 0012): the
	/// wallet's own top-up rule — a card or bank line whose merchant contains this
	/// text, for a whole number of dollars when `whole_dollars`, is money into it.
	/// `sms` (migration 0013): which SMS belong to this wallet — words the SMS
	/// contains (any one) and/or the sender the owner's Shortcut names.
	/// 19 Oct 2026 (migration 0013): `opening_paid` — what the owner paid for the
	/// opening credit when the shop gave a bonus (default: the opening balance);
	/// `topup.deal` — the shop's usual bonus ("pay 300, get 350"), the credit an
	/// automatic top-up is given by default (the owner's word overrides it).
	wallet?: { since: string; opening_balance: string; opening_paid?: string; precounted: string; precounted_category?: string; topup?: { merchant: string; whole_dollars: boolean; deal?: { paid: string; credit: string } }; spend_category?: string; sms?: { keywords?: string[]; sender?: string } };
}

export interface SeedFile {
	/// The owner's banks and the mail domains each sends from (src/bank-list.ts):
	/// the ONLY mail that can ever be read as a bank's. May be empty.
	banks: BankEntry[];
	accounts: SeedAccount[];
}

/// Every reason this seed is unsafe to load. Empty = fine. `homeCurrency`
/// (wrangler.toml's LEDGER_HOME_CURRENCY, when set): cash and wallets must be in it.
export function seedProblems(seed: SeedFile, opts: { homeCurrency?: string | null } = {}): string[] {
	const problems: string[] = [];
	if (seed.banks === undefined) problems.push('the file has no "banks" list: name each bank and the mail domains it sends from (docs/accounts.md), or write "banks": [] if none emails you');
	else problems.push(...bankListProblems(seed.banks));
	const listed = new Set(Array.isArray(seed.banks) ? seed.banks.map((b) => b?.institution) : []);
	const ids = new Set(seed.accounts.map((a) => a.id));
	if (ids.size !== seed.accounts.length) problems.push("two accounts share an id");
	const numbers = new Set<string>();
	const wallets = new Map<string, string>();
	for (const a of seed.accounts) {
		const where = `account ${a.id}`;
		if (!(ACCOUNT_KINDS as readonly string[]).includes(a.kind)) problems.push(`${where}: unknown kind ${a.kind}`);
		if (!/^[A-Z]{3}$/.test(a.currency)) problems.push(`${where}: currency must be a 3-letter code`);
		if (a.last4 !== null && !/^\d{4}$/.test(a.last4)) problems.push(`${where}: last4 must be exactly 4 digits`);
		if (opts.homeCurrency && (a.kind === "cash" || a.kind === "wallet") && a.currency !== opts.homeCurrency) problems.push(`${where}: cash and wallets are kept in your home currency (${opts.homeCurrency}), not ${a.currency}`);
		if (a.last4 === null && a.kind !== "cash" && a.kind !== "wallet" && !a.todo) problems.push(`${where}: a missing last4 needs a todo saying who supplies it`);
		if (a.last4) {
			const key = `${a.institution}/${a.last4}`;
			if (numbers.has(key)) problems.push(`${where}: ${key} is already used`);
			numbers.add(key);
		}
		for (const name of a.wallet_names ?? []) {
			if (a.kind !== "credit_card" && a.kind !== "debit_card") problems.push(`${where}: only a card has a Wallet name`);
			const key = walletKey(name);
			if (!key) problems.push(`${where}: an empty Wallet name`);
			else if (wallets.has(key)) problems.push(`${where}: Wallet name "${name}" already belongs to ${wallets.get(key)}`);
			else wallets.set(key, a.id);
		}
		if (a.replaced_by) {
			const next = seed.accounts.find((b) => b.id === a.replaced_by);
			if (!next || next.kind !== a.kind || next.institution !== a.institution || next.currency !== a.currency) problems.push(`${where}: replaced_by must name a ${a.institution} ${a.kind} in ${a.currency}`);
		}
		if (a.kind === "wallet") {
			const w = a.wallet;
			if (!w) problems.push(`${where}: a wallet needs its wallet settings (since, opening_balance, precounted, precounted_category)`);
			else {
				if (!isIsoDate(w.since)) problems.push(`${where}: wallet.since must be YYYY-MM-DD`);
				let opening = NaN;
				let pre = NaN;
				let paid = NaN;
				try {
					opening = parseMajor(w.opening_balance, a.currency);
					pre = parseMajor(w.precounted, a.currency);
					paid = w.opening_paid === undefined ? opening : parseMajor(w.opening_paid, a.currency);
					if (w.topup?.deal && !(parseMajor(w.topup.deal.paid, a.currency) > 0 && parseMajor(w.topup.deal.credit, a.currency) >= parseMajor(w.topup.deal.paid, a.currency))) problems.push(`${where}: wallet.topup.deal needs paid above zero and credit at least paid`);
				} catch {
					problems.push(`${where}: wallet amounts must be amounts, e.g. "12.50"`);
				}
				// Pre-counted is money: at most what the opening credit cost.
				if (pre < 0 || pre > paid) problems.push(`${where}: wallet.precounted must be between 0 and what the opening balance cost`);
				if (paid > opening) problems.push(`${where}: wallet.opening_paid cannot be more than the opening balance (a bonus only adds credit)`);
				if (pre > 0 && !(w.precounted_category ?? "").trim()) problems.push(`${where}: wallet.precounted_category is empty`);
				if (w.topup !== undefined && (!w.topup.merchant?.replace(/[^\p{L}\p{N}]+/gu, "") || typeof w.topup.whole_dollars !== "boolean")) problems.push(`${where}: wallet.topup needs a merchant text and whole_dollars true or false`);
				if (w.topup !== undefined && a.institution === "grab") problems.push(`${where}: GrabPay's top-up rule is built in; it takes no wallet.topup`);
				if (w.sms !== undefined && !(w.sms.keywords ?? []).some((k) => k.replace(/[^\p{L}\p{N}]+/gu, "")) && !w.sms.sender?.trim()) problems.push(`${where}: wallet.sms needs keywords or a sender`);
				if (w.sms !== undefined && a.institution === "grab") problems.push(`${where}: GrabPay is kept by Grab's own mail; it takes no wallet.sms`);
			}
		} else if (a.wallet) problems.push(`${where}: only a wallet has wallet settings`);
		// A bank or card whose bank is not on the list can never have its mail read:
		// its alerts would never come. Either list the bank, or say it sends none.
		if ((a.kind === "bank" || a.kind === "credit_card" || a.kind === "debit_card") && !listed.has(a.institution) && a.alerts_expected !== false)
			problems.push(`${where}: its bank "${a.institution}" is not in "banks", so none of its mail can be read — add the bank and its mail domains, or set "alerts_expected": false`);
		if (a.kind === "debit_card") {
			const bank = seed.accounts.find((b) => b.id === a.settles_to);
			if (!bank || bank.kind !== "bank") problems.push(`${where}: a debit card must settle to a bank account`);
			else if (bank.currency !== a.currency) problems.push(`${where}: its bank account is in another currency`);
		} else if (a.settles_to) {
			problems.push(`${where}: only a debit card settles to another account`);
		}
	}
	return problems;
}

export function seedAccounts(seed: SeedFile, now: string): Account[] {
	const problems = seedProblems(seed);
	if (problems.length) throw new Error(`seed/accounts.json is not safe to load:\n- ${problems.join("\n- ")}`);
	// Banks before the debit cards that point at them (settles_to is a foreign key).
	const ordered = [...seed.accounts].sort((a, b) => Number(!!a.settles_to) - Number(!!b.settles_to));
	return ordered.map((a) => ({
		id: a.id,
		institution: a.institution,
		kind: a.kind,
		name: a.name,
		last4: a.last4,
		currency: a.currency,
		settles_to: a.settles_to ?? null,
		// A debit card's spending is reported by alert; its statement is the bank's.
		alerts_expected: a.alerts_expected === false || a.kind === "cash" ? 0 : 1,
		has_statements: a.has_statements === false || a.kind === "cash" || a.kind === "debit_card" ? 0 : 1,
		active: a.active === false ? 0 : 1,
		created_at: now,
		...(a.kind === "wallet" && a.wallet
			? {
					wallet_since: a.wallet.since,
					wallet_opening_minor: parseMajor(a.wallet.opening_balance, a.currency),
					wallet_precounted_minor: parseMajor(a.wallet.precounted, a.currency),
					...(a.wallet.opening_paid !== undefined ? { wallet_opening_paid_minor: parseMajor(a.wallet.opening_paid, a.currency) } : {}),
					...(a.wallet.topup?.deal ? { wallet_topup_deal_paid_minor: parseMajor(a.wallet.topup.deal.paid, a.currency), wallet_topup_deal_credit_minor: parseMajor(a.wallet.topup.deal.credit, a.currency) } : {}),
					wallet_precounted_category: (a.wallet.precounted_category ?? "").trim() || null,
					...(a.wallet.topup ? { wallet_topup_merchant: a.wallet.topup.merchant, wallet_topup_whole_dollars: a.wallet.topup.whole_dollars ? 1 : 0 } : {}),
					...(a.wallet.spend_category?.trim() ? { wallet_spend_category: a.wallet.spend_category.trim() } : {}),
					...(a.wallet.sms
						? { wallet_sms_keywords: (a.wallet.sms.keywords ?? []).map((k) => k.trim()).filter(Boolean).join(",") || null, wallet_sms_sender: a.wallet.sms.sender?.trim() || null }
						: {}),
				}
			: {}),
	}));
}

export const ACCOUNT_INSERT =
	"INSERT OR IGNORE INTO accounts (id, institution, kind, name, last4, currency, settles_to, alerts_expected, has_statements, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function accountValues(a: Account): unknown[] {
	return [a.id, a.institution, a.kind, a.name, a.last4, a.currency, a.settles_to, a.alerts_expected, a.has_statements, a.active, a.created_at];
}

export const REPLACED_UPDATE = "UPDATE accounts SET replaced_by = ? WHERE id = ? AND replaced_by IS NULL";

/// A wallet's settings (migration 0010); a no-op once set (the owner's later word is never overwritten).
export const WALLET_SETTINGS_UPDATE =
	"UPDATE accounts SET wallet_since = ?, wallet_opening_minor = ?, wallet_precounted_minor = ?, wallet_precounted_category = ? WHERE id = ? AND wallet_since IS NULL";

export function walletSettingsValues(a: Account): unknown[] {
	return [a.wallet_since ?? null, a.wallet_opening_minor ?? null, a.wallet_precounted_minor ?? null, a.wallet_precounted_category ?? null, a.id];
}

/// A wallet's own top-up rule and default category (migration 0012); a no-op once either is set.
export const WALLET_RULE_UPDATE =
	"UPDATE accounts SET wallet_topup_merchant = ?, wallet_topup_whole_dollars = ?, wallet_spend_category = ? WHERE id = ? AND wallet_topup_merchant IS NULL AND wallet_spend_category IS NULL";

export function walletRuleValues(a: Account): unknown[] {
	return [a.wallet_topup_merchant ?? null, a.wallet_topup_whole_dollars ?? null, a.wallet_spend_category ?? null, a.id];
}

/// Migration 0013's wallet settings — which SMS belong to it, what its opening
/// credit cost, its usual top-up bonus; a no-op once any is set.
export const WALLET_SMS_UPDATE =
	"UPDATE accounts SET wallet_sms_keywords = ?, wallet_sms_sender = ?, wallet_opening_paid_minor = ?, wallet_topup_deal_paid_minor = ?, wallet_topup_deal_credit_minor = ? WHERE id = ? AND wallet_sms_keywords IS NULL AND wallet_sms_sender IS NULL AND wallet_opening_paid_minor IS NULL AND wallet_topup_deal_paid_minor IS NULL";

export function walletSmsValues(a: Account): unknown[] {
	return [a.wallet_sms_keywords ?? null, a.wallet_sms_sender ?? null, a.wallet_opening_paid_minor ?? null, a.wallet_topup_deal_paid_minor ?? null, a.wallet_topup_deal_credit_minor ?? null, a.id];
}

/// The owner's bank list into sync_state['banks'] (src/bank-list.ts): the worker reads it every tick.
export const BANKS_UPSERT = `INSERT INTO sync_state (key, value, updated_at) VALUES ('${BANKS_KEY}', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

export function banksValues(seed: SeedFile, now: string): unknown[] {
	return [JSON.stringify(normaliseBanks(seed.banks)), now];
}

export const WALLET_INSERT = "INSERT OR IGNORE INTO account_wallet_names (wallet_key, account_id) VALUES (?, ?)";

export function walletRows(seed: SeedFile): { wallet_key: string; account_id: string }[] {
	return seed.accounts.flatMap((a) => (a.wallet_names ?? []).map((name) => ({ wallet_key: walletKey(name), account_id: a.id })));
}

/// The seed as one SQL file for `wrangler d1 execute --file` (INSTALL.md step 5,
/// "Load your accounts"). Literal values, INSERT OR IGNORE: safe to run twice.
export const SEED_CREATED_AT = "2026-10-09T00:00:00.000Z";

function sqlLiteral(v: unknown): string {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number") return String(v);
	return `'${String(v).replace(/'/g, "''")}'`;
}

export function seedSql(seed: SeedFile, now = SEED_CREATED_AT): string {
	const fill = (sql: string, values: readonly unknown[]) => {
		let i = 0;
		return sql.replace(/\?/g, () => sqlLiteral(values[i++]));
	};
	const lines = ["-- Generated by src/seed.ts seedSql() (npm run seed:sql). Do not edit: change the .json and run it again."];
	// The bank list REPLACES the stored one (an edit to it, a domain removed, takes effect on the next load).
	lines.push(`${fill(BANKS_UPSERT, banksValues(seed, now))};`);
	const accounts = seedAccounts(seed, now);
	for (const a of accounts) lines.push(`${fill(ACCOUNT_INSERT, accountValues(a))};`);
	for (const w of walletRows(seed)) lines.push(`${fill(WALLET_INSERT, [w.wallet_key, w.account_id])};`);
	// After migration 0007 (accounts.replaced_by); a no-op when already set.
	for (const a of seed.accounts.filter((x) => x.replaced_by)) lines.push(`${fill(REPLACED_UPDATE, [a.replaced_by, a.id])};`);
	// After migration 0010 (the wallet columns).
	for (const a of accounts.filter((x) => x.kind === "wallet")) lines.push(`${fill(WALLET_SETTINGS_UPDATE, walletSettingsValues(a))};`);
	// After migration 0012 (a wallet's own top-up rule and default category).
	for (const a of accounts.filter((x) => x.kind === "wallet" && (x.wallet_topup_merchant || x.wallet_spend_category))) lines.push(`${fill(WALLET_RULE_UPDATE, walletRuleValues(a))};`);
	// After migration 0013 (which SMS belong to a wallet, its opening credit's cost, its top-up bonus).
	for (const a of accounts.filter((x) => x.kind === "wallet" && (x.wallet_sms_keywords || x.wallet_sms_sender || x.wallet_opening_paid_minor != null || x.wallet_topup_deal_paid_minor != null))) lines.push(`${fill(WALLET_SMS_UPDATE, walletSmsValues(a))};`);
	return `${lines.join("\n")}\n`;
}
