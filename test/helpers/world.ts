/// A small made-up world for the read-side and edit tests: accounts,
/// an engine with a deterministic clock and ids, and row builders for the
/// tables the engine does not fill itself (trips, subscriptions, statements).
/// Every account, merchant and amount is INVENTED.

import { insertRow, type Db } from "../../src/db";
import type { Engine } from "../../src/engine";
import { ACCOUNT_INSERT, accountValues } from "../../src/seed";
import { walletKey } from "../../src/shortcut";
import type { Account, Actor } from "../../src/types";
import type { SubscriptionRow, TripRow } from "../../src/views";
import { ACCOUNTS, CARD_T } from "./fixtures";

/// 台新 with no email alerts, as the owner's really is.
export const TAISHIN_NO_EMAIL: Account = { ...CARD_T, alerts_expected: 0 };
export const WORLD_ACCOUNTS: readonly Account[] = ACCOUNTS.map((a) => (a.id === CARD_T.id ? TAISHIN_NO_EMAIL : a));

export async function addAccounts(db: Db, accounts: readonly Account[] = WORLD_ACCOUNTS): Promise<void> {
	for (const a of accounts) await db.prepare(ACCOUNT_INSERT).bind(...accountValues(a)).run();
}

export async function addWallet(db: Db, name: string, accountId: string): Promise<void> {
	await db.prepare("INSERT INTO account_wallet_names (wallet_key, account_id) VALUES (?, ?)").bind(walletKey(name), accountId).run();
}

export async function addRate(db: Db, date: string, currency: string, rate: number): Promise<void> {
	await db.prepare("INSERT INTO fx_rates (date, currency, quote, rate, source) VALUES (?, ?, 'SGD', ?, 'test')").bind(date, currency, rate).run();
}

export function testEngine(db: Db, actor: Actor = "rules"): Engine {
	let tick = 0;
	let ids = 0;
	return {
		db,
		now: () => new Date(Date.UTC(2026, 9, 9, 0, 0, 0, tick++)).toISOString(),
		newId: () => `id-${String(++ids).padStart(4, "0")}`,
		ownNames: ["ALEX DOE"],
		aliases: [],
		actor,
	};
}

export async function put(db: Db, table: string, row: object): Promise<void> {
	await insertRow(db, table, row).run();
}

export function tripRow(over: Partial<TripRow> & Pick<TripRow, "id">): TripRow {
	return {
		name: null,
		destination: "Testville, JP",
		countries_json: '["JP"]',
		start_date: "2026-03-09",
		end_date: "2026-03-13",
		status: "proposed",
		evidence_ids_json: "[]",
		confirmed_at: null,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

export function subscriptionRow(over: Partial<SubscriptionRow> & Pick<SubscriptionRow, "id" | "merchant_key">): SubscriptionRow {
	return {
		merchant_name: null,
		currency: "SGD",
		cadence: "monthly",
		amount_minor: 1000,
		previous_amount_minor: null,
		price_changed_on: null,
		first_seen: "2026-01-01",
		last_charged: "2026-03-01",
		next_renewal: "2026-04-01",
		occurrences: 3,
		status: "active",
		owner_status: null,
		line_ids_json: "[]",
		updated_at: "2026-01-01T00:00:00.000Z",
		...over,
	};
}
