/// Builds the page's fixtures: MADE-UP data only, in the exact CONTRACT §5
/// shapes, because every shape is produced by the real builders in src/views.ts
/// (lineView, totals, tripView, subscriptionView, monthView) and
/// src/coverage.ts. Nothing here is the owner's: accounts, merchants, amounts and
/// rates are invented.
///
///   cd ledger && npx vite-node page/fixtures/make-fixtures.ts
///
/// Writes one JSON file per route (see page/README.md; English) plus all.js —
/// every language's set — which the page loads in ?fixtures=1 mode so it also
/// works opened straight from disk.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountCoverage } from "../../src/coverage";
import { convertMinor, money } from "../../src/money";
import type { ReconResult } from "../../src/reconcile";
import type { ReimburseRange } from "../../src/reimbursable";
import { isSpending } from "../../src/transfers";
import type { Account, EvidenceType, LineRow, Statement } from "../../src/types";
import { lineView, monthView, subscriptionView, totals, tripView, type SubscriptionRow, type TripRow } from "../../src/views";
import { setHome, SINGAPORE } from "../../src/home";
import { LANGUAGES, setLanguage, type Language } from "../../src/words";

setHome(SINGAPORE);

const OUT = dirname(fileURLToPath(import.meta.url));
const TODAY = "2026-10-09";
const MONTH = "2026-09";
const TS = "2026-10-09T01:00:00.000Z";

/// The demo's names in each language: what an owner writing in it might have typed
/// for his accounts, notes and trips. Merchants are the same everywhere (they are
/// the shops' own names). Every message the real builders write follows the language.
const NAMES = {
	en: { dbs: "DBS account", dbsDebit: "DBS debit card", hsbcA: "HSBC card A", hsbcB: "HSBC card B", citi: "Citi card", tsA: "Taishin card A", tsB: "Taishin card B", cash: "Cash", clientDinner: "Client dinner", coffee: "Personal coffee", sharedDinner: "Shared dinner", clientVisit: "Client visit", bangkok: "Bangkok business trip", japan: "Japan: Tokyo + Osaka", taipei: "Taipei" },
	"zh-Hant": { dbs: "DBS 帳戶", dbsDebit: "DBS 簽帳卡", hsbcA: "HSBC 信用卡 A", hsbcB: "HSBC 信用卡 B", citi: "Citi 信用卡", tsA: "台新 信用卡 A", tsB: "台新 信用卡 B", cash: "現金", clientDinner: "客戶晚餐", coffee: "私人咖啡", sharedDinner: "分攤晚餐", clientVisit: "客戶拜訪", bangkok: "曼谷出差", japan: "日本 東京＋大阪", taipei: "台北" },
} as const;

function build(lang: Language): { views: number; FIX: Record<string, unknown> } {
	setLanguage(lang);
	const N = NAMES[lang];
	// ------------------------------------------------------------ accounts (made up)
	function acct(id: string, institution: string, kind: Account["kind"], name: string, currency: string, alerts: 0 | 1, stmts: 0 | 1, settles: string | null = null): Account {
		return { id, institution, kind, name, last4: null, currency, settles_to: settles, alerts_expected: alerts, has_statements: stmts, active: 1, created_at: TS };
	}
	const A = {
		dbs: acct("acc-demo-dbs", "DBS", "bank", N.dbs, "SGD", 1, 1),
		dbsDebit: acct("acc-demo-dbs-debit", "DBS", "debit_card", N.dbsDebit, "SGD", 1, 0, "acc-demo-dbs"),
		hsbcA: acct("acc-demo-hsbc-a", "HSBC", "credit_card", N.hsbcA, "SGD", 1, 1),
		hsbcB: acct("acc-demo-hsbc-b", "HSBC", "credit_card", N.hsbcB, "SGD", 1, 1),
		citi: acct("acc-demo-citi", "Citi", "credit_card", N.citi, "SGD", 1, 1),
		tsA: acct("acc-demo-taishin-a", "Taishin", "credit_card", N.tsA, "TWD", 0, 1),
		tsB: acct("acc-demo-taishin-b", "Taishin", "credit_card", N.tsB, "TWD", 0, 1),
		cash: acct("acc-demo-cash", "Cash", "cash", N.cash, "SGD", 0, 0),
	};
	const ACCOUNTS = Object.values(A);
	const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));
	const accountRef = (a: Account) => ({ id: a.id, name: a.name, kind: a.kind, institution: a.institution });

	// ------------------------------------------------------------ statements (made up)
	function stmt(id: string, account: Account, start: string, end: string, status: Statement["recon_status"], expected: number | null, ledger: number, problems: ReconResult["problems"] = []): Statement {
		const r: ReconResult = {
			ok: status === "reconciled",
			rule: account.kind === "bank" ? "bank_balance" : "card_total",
			expected_minor: expected,
			ledger_minor: ledger,
			statement_lines_minor: expected ?? ledger,
			difference_minor: expected === null ? null : ledger - expected,
			line_count: 9,
			problems,
		};
		return { id, account_id: account.id, period_start: start, period_end: end, currency: account.currency, opening_balance_minor: null, closing_balance_minor: null, printed_net_minor: expected, message_id: null, attachment_name: "statement.pdf", recon_status: status, recon_checked_at: "2026-10-08T22:10:00.000Z", recon_detail_json: JSON.stringify(r), created_at: TS };
	}
	const S = {
		hsbcA: stmt("st-demo-hsbc-a-0925", A.hsbcA, "2026-08-26", "2026-09-25", "reconciled", 241_755, 241_755),
		hsbcB: stmt("st-demo-hsbc-b-0904", A.hsbcB, "2026-08-05", "2026-09-04", "reconciled", 61_240, 61_240),
		citi: stmt("st-demo-citi-0930", A.citi, "2026-09-01", "2026-09-30", "escalated", 61_377, 60_177, [
			{ code: "ledger_mismatch", message: "the ledger is SGD 12.00 short of the statement", ids: [] },
			{ code: "unmatched_statement_line", message: "one statement line has no ledger line yet", ids: ["ev-demo-1"] },
		]),
		dbs: stmt("st-demo-dbs-0930", A.dbs, "2026-09-01", "2026-09-30", "reconciled", 512_310, 512_310),
		tsA: stmt("st-demo-taishin-a-0915", A.tsA, "2026-08-16", "2026-09-15", "reconciled", 1_184_000, 1_184_000),
		tsB: stmt("st-demo-taishin-b-0910", A.tsB, "2026-08-11", "2026-09-10", "pending", null, 0),
	};
	const STATEMENTS = Object.values(S);

	// ------------------------------------------------------------ lines (made up)
	const JPY_SGD = 0.00905; // invented reference rates
	const USD_SGD = 1.3021;
	const JPY_TWD = 0.2205;
	const TWD_SGD = 0.0405;

	let seq = 0;
	type L = Partial<LineRow> & { account: Account; date: string; merchant: string; category: string | null };
	const lines: { row: LineRow; ev: EvidenceType[]; trip: string | null }[] = [];

	function base(p: L): LineRow {
		seq++;
		return {
			id: `ln-demo-${String(seq).padStart(3, "0")}`,
			account_id: p.account.id,
			kind: "purchase",
			state: "open",
			txn_date: p.date,
			post_date: null,
			merchant_raw: p.merchant.toUpperCase(),
			merchant_key: p.merchant.toLowerCase().replace(/[^a-z0-9]+/g, ""),
			merchant_name: p.merchant,
			merchant_country: "SG",
			category: p.category,
			orig_currency: "SGD",
			orig_minor: 0,
			bill_currency: p.account.currency,
			bill_minor: 0,
			bill_status: "exact",
			fee_minor: 0,
			market_rate: null,
			markup: null,
			markup_source: null,
			effective_rate: null,
			observed_markup: null,
			home_minor: 0,
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
			created_at: TS,
			updated_at: TS,
		};
	}

	/// An SGD purchase on an SGD account.
	function home(p: L & { cents: number }, ev: EvidenceType[], trip: string | null = null): LineRow {
		const row = { ...base(p), ...strip(p), orig_minor: p.cents, bill_minor: p.cents, home_minor: p.cents };
		lines.push({ row, ev, trip });
		return row;
	}

	/// A foreign purchase on an SGD card: an estimate (day's rate × (1 + markup)),
	/// or — when `billed` is given — confirmed by the statement.
	function foreignOnHome(p: L & { cur: string; orig: number; rate: number; markup: number; source: "learned" | "bank_default"; billed?: number }, ev: EvidenceType[], trip: string | null = null): LineRow {
		const atMarket = convertMinor(p.orig, p.cur, "SGD", p.rate);
		const bill = p.billed ?? convertMinor(p.orig, p.cur, "SGD", p.rate * (1 + p.markup));
		const confirmed = p.billed !== undefined;
		const eff = confirmed ? bill / 100 / (p.orig / (p.cur === "JPY" ? 1 : 100)) : null;
		const row: LineRow = {
			...base(p),
			...strip(p),
			merchant_country: p.merchant_country ?? (p.cur === "JPY" ? "JP" : "US"),
			orig_currency: p.cur,
			orig_minor: p.orig,
			bill_minor: bill,
			bill_status: confirmed ? "confirmed" : "estimate",
			fee_minor: bill - atMarket,
			market_rate: p.rate,
			markup: p.markup,
			markup_source: p.source,
			effective_rate: eff === null ? null : Math.round(eff * 1e6) / 1e6,
			observed_markup: eff === null ? null : Math.round((eff / p.rate - 1) * 1e4) / 1e4,
			home_minor: bill,
			home_status: confirmed ? "confirmed" : "estimate",
			home_rate: null,
		};
		lines.push({ row, ev, trip });
		return row;
	}

	/// A JPY purchase on a TWD card (a Taiwanese card): billed TWD estimate, SGD at reference.
	function foreignOnTwd(p: L & { orig: number }, ev: EvidenceType[], trip: string | null = null): LineRow {
		const markup = 0.015;
		const bill = convertMinor(p.orig, "JPY", "TWD", JPY_TWD * (1 + markup));
		const row: LineRow = {
			...base(p),
			...strip(p),
			merchant_country: "JP",
			orig_currency: "JPY",
			orig_minor: p.orig,
			bill_minor: bill,
			bill_status: "estimate",
			fee_minor: bill - convertMinor(p.orig, "JPY", "TWD", JPY_TWD),
			market_rate: JPY_TWD,
			markup,
			markup_source: "bank_default",
			home_minor: convertMinor(bill, "TWD", "SGD", TWD_SGD),
			home_status: "reference",
			home_rate: TWD_SGD,
		};
		lines.push({ row, ev, trip });
		return row;
	}

	/// Foreign cash: held in its own currency, SGD at the reference rate.
	function cashForeign(p: L & { orig: number }, trip: string | null = null): LineRow {
		const row: LineRow = {
			...base(p),
			...strip(p),
			merchant_country: "JP",
			orig_currency: "JPY",
			orig_minor: p.orig,
			bill_currency: "JPY",
			bill_minor: p.orig,
			home_minor: convertMinor(p.orig, "JPY", "SGD", JPY_SGD),
			home_status: "reference",
			home_rate: JPY_SGD,
			created_by: "owner",
		};
		lines.push({ row, ev: ["manual"], trip });
		return row;
	}

	function strip(p: L): Partial<LineRow> {
		const { account: _a, date: _d, merchant: _m, category: _c, ...rest } = p as L & Record<string, unknown>;
		for (const k of ["cents", "cur", "orig", "rate", "source", "billed"]) delete (rest as Record<string, unknown>)[k];
		return rest as Partial<LineRow>;
	}

	const TRIP_JP = "trip-demo-japan";
	const TRIP_TPE = "trip-demo-taipei";
	const TRIP_KL = "trip-demo-kl";

	// Taipei, July (confirmed trip, earlier)
	home({ account: A.hsbcA, date: "2026-07-02", merchant: "Scoot", category: "flights", state: "reconciled", statement_id: "st-demo-hsbc-a-0725", cents: 41_200 }, ["alert", "receipt", "statement_line"], TRIP_TPE);
	lines.push({ row: { ...base({ account: A.tsA, date: "2026-07-10", merchant: "Eslite Bookstore", category: "shopping" }), merchant_country: "TW", orig_currency: "TWD", orig_minor: 128_000, bill_minor: 128_000, home_minor: convertMinor(128_000, "TWD", "SGD", TWD_SGD), home_status: "reference", home_rate: TWD_SGD, state: "reconciled", statement_id: "st-demo-taishin-a-0725" }, ev: ["statement_line"], trip: TRIP_TPE });
	lines.push({ row: { ...base({ account: A.tsA, date: "2026-07-11", merchant: "Din Tai Fung", category: "dining" }), merchant_country: "TW", orig_currency: "TWD", orig_minor: 216_000, bill_minor: 216_000, home_minor: convertMinor(216_000, "TWD", "SGD", TWD_SGD), home_status: "reference", home_rate: TWD_SGD, state: "reconciled", statement_id: "st-demo-taishin-a-0725" }, ev: ["apple_pay_shortcut", "statement_line"], trip: TRIP_TPE });

	// Japan, booked in August, travelled 12–19 September
	home({ account: A.hsbcA, date: "2026-08-20", merchant: "Singapore Airlines", category: "flights", state: "reconciled", statement_id: "st-demo-hsbc-a-0825", cents: 118_000 }, ["alert", "receipt", "statement_line"], TRIP_JP);
	foreignOnHome({ account: A.citi, date: "2026-08-22", merchant: "Agoda · Shinjuku hotel", category: "lodging", cur: "JPY", orig: 98_000, rate: 0.00903, markup: 0.0325, source: "bank_default", billed: 91_420, state: "reconciled", statement_id: "st-demo-citi-0831" }, ["alert", "receipt", "statement_line"], TRIP_JP);
	foreignOnHome({ account: A.citi, date: "2026-09-12", merchant: "Suica", category: "transport", cur: "JPY", orig: 5_000, rate: JPY_SGD, markup: 0.0331, source: "learned", billed: 4_675, state: "posted", statement_id: S.citi.id }, ["apple_pay_shortcut", "alert", "statement_line"], TRIP_JP);
	cashForeign({ account: A.cash, date: "2026-09-13", merchant: "Ichiran Ramen", category: "dining", orig: 1_200 }, TRIP_JP);
	foreignOnHome({ account: A.hsbcB, date: "2026-09-13", merchant: "Uniqlo Ginza", category: "shopping", cur: "JPY", orig: 12_900, rate: JPY_SGD, markup: 0.0325, source: "bank_default" }, ["alert", "apple_pay_shortcut"], TRIP_JP);
	foreignOnHome({ account: A.hsbcB, date: "2026-09-14", merchant: "Lawson", category: "groceries", cur: "JPY", orig: 860, rate: 0.00906, markup: 0.0325, source: "bank_default" }, ["apple_pay_shortcut"], TRIP_JP);
	foreignOnHome({ account: A.citi, date: "2026-09-15", merchant: "JR West Shinkansen", category: "transport", cur: "JPY", orig: 14_720, rate: 0.00907, markup: 0.0331, source: "learned", billed: 13_790, state: "posted", statement_id: S.citi.id }, ["alert", "statement_line"], TRIP_JP);
	foreignOnHome({ account: A.hsbcA, date: "2026-09-16", merchant: "Hotel Granvia Osaka", category: "lodging", cur: "JPY", orig: 42_000, rate: 0.00904, markup: 0.0318, source: "learned" }, ["alert", "receipt"], TRIP_JP);
	foreignOnTwd({ account: A.tsA, date: "2026-09-17", merchant: "Don Quijote Namba", category: "shopping", orig: 23_450 }, ["apple_pay_shortcut"], TRIP_JP);
	cashForeign({ account: A.cash, date: "2026-09-18", merchant: "Kuromon Market", category: "dining", orig: 3_500 }, TRIP_JP);
	foreignOnHome({ account: A.hsbcB, date: "2026-09-19", merchant: "Kansai Airport · Kani Doraku", category: "dining", cur: "JPY", orig: 2_200, rate: 0.00905, markup: 0.0325, source: "bank_default" }, ["alert", "apple_pay_shortcut"], TRIP_JP);

	// Singapore, September
	home({ account: A.dbsDebit, date: "2026-09-01", merchant: "NTUC FairPrice", category: "groceries", cents: 8_640 }, ["alert", "apple_pay_shortcut"]);
	home({ account: A.hsbcA, date: "2026-09-02", merchant: "Netflix", category: "subscriptions", state: "reconciled", statement_id: S.hsbcA.id, cents: 2_598 }, ["alert", "statement_line"]);
	home({ account: A.citi, date: "2026-09-03", merchant: "Spotify", category: "subscriptions", state: "posted", statement_id: S.citi.id, cents: 1_199 }, ["alert", "statement_line"]);
	home({ account: A.hsbcA, date: "2026-09-04", merchant: "Grab", category: "transport", state: "reconciled", statement_id: S.hsbcA.id, cents: 1_870 }, ["alert", "statement_line"]);
	home({ account: A.dbsDebit, date: "2026-09-05", merchant: "Toast Box", category: "dining", cents: 760 }, ["alert", "apple_pay_shortcut"]);
	const shopee = home({ account: A.hsbcB, date: "2026-09-06", merchant: "Shopee", category: "shopping", cents: 6_490 }, ["alert"]);
	home({ account: A.dbs, date: "2026-09-08", merchant: "SP Group", category: "utilities", state: "reconciled", statement_id: S.dbs.id, cents: 14_235 }, ["alert", "statement_line"]);
	home({ account: A.hsbcA, date: "2026-09-09", merchant: "Guardian", category: "health", state: "reconciled", statement_id: S.hsbcA.id, cents: 3_215 }, ["apple_pay_shortcut", "statement_line"]);
	foreignOnHome({ account: A.citi, date: "2026-09-10", merchant: "OpenAI", category: "subscriptions", cur: "USD", orig: 2_000, rate: USD_SGD, markup: 0.0331, source: "learned", billed: 2_691, state: "posted", statement_id: S.citi.id }, ["alert", "receipt", "statement_line"]);
	home({ account: A.hsbcA, date: "2026-09-11", merchant: "Marina Hotel deposit", category: "lodging", flag_not_on_statement: 1, cents: 5_800 }, ["alert"]);
	home({ account: A.hsbcA, date: "2026-09-22", merchant: "Paradise Dynasty", category: "dining", state: "reconciled", statement_id: S.hsbcA.id, cents: 18_600, note: N.clientDinner }, ["alert", "apple_pay_shortcut", "statement_line"]);
	home({ account: A.hsbcB, date: "2026-09-23", merchant: "Grab", category: "transport", cents: 2_460 }, ["alert"]);
	home({ account: A.hsbcB, date: "2026-09-23", merchant: "Starbucks", category: "dining", reimbursable_override: 0, cents: 790, note: N.coffee }, ["apple_pay_shortcut"]);
	home({ account: A.citi, date: "2026-09-25", merchant: "Apple iCloud", category: "subscriptions", state: "posted", statement_id: S.citi.id, cents: 398 }, ["statement_line", "alert"]);
	const shopeeRefund = home({ account: A.hsbcB, date: "2026-09-26", merchant: "Shopee", category: "shopping", kind: "refund", cents: -1_990 }, ["alert"]);
	shopeeRefund.refund_of = shopee.id;
	home({ account: A.citi, date: "2026-09-27", merchant: "Amazon SG", category: "shopping", kind: "refund", flag_unlinked_refund: 1, state: "posted", statement_id: S.citi.id, cents: -1_200 }, ["statement_line"]);
	home({ account: A.citi, date: "2026-09-28", merchant: "Citi annual fee", category: "fees", kind: "fee", flag_missed_by_alerts: 1, state: "posted", statement_id: S.citi.id, cents: 19_620 }, ["statement_line"]);
	home({ account: A.hsbcA, date: "2026-09-27", merchant: "Payment — thank you", category: null, kind: "card_payment", transfer_group: "tg-demo-1", state: "reconciled", statement_id: S.hsbcA.id, cents: -98_000 }, ["statement_line"]);
	home({ account: A.dbs, date: "2026-09-27", merchant: "HSBC card payment", category: null, kind: "card_payment", transfer_group: "tg-demo-1", state: "reconciled", statement_id: S.dbs.id, cents: 98_000 }, ["alert", "statement_line"]);
	home({ account: A.dbs, date: "2026-09-28", merchant: "PayNow to A. Tan", category: "dining", state: "reconciled", statement_id: S.dbs.id, cents: 4_000, note: N.sharedDinner }, ["alert", "statement_line"]);
	home({ account: A.dbs, date: "2026-09-29", merchant: "Demo Pte Ltd salary", category: "income", kind: "income", state: "reconciled", statement_id: S.dbs.id, cents: -650_000 }, ["alert", "statement_line"]);
	home({ account: A.hsbcA, date: "2026-09-29", merchant: "Cold Storage", category: "groceries", cents: 5_312 }, ["alert", "apple_pay_shortcut"]);
	lines.push({ row: { ...base({ account: A.tsB, date: "2026-09-30", merchant: "FamilyMart", category: "groceries" }), merchant_country: "TW", orig_currency: "TWD", orig_minor: 18_500, bill_minor: 18_500, home_minor: 0, home_status: "reference", flag_no_rate: 1 }, ev: ["apple_pay_shortcut"], trip: null });
	home({ account: A.dbsDebit, date: "2026-09-30", merchant: "Kopitiam", category: "dining", state: "review", cents: 1_150 }, ["alert"]);

	// October so far (the month picker has somewhere to go)
	home({ account: A.hsbcA, date: "2026-10-02", merchant: "Scoot", category: "flights", cents: 28_900 }, ["alert", "receipt"], TRIP_KL);
	home({ account: A.hsbcB, date: "2026-10-03", merchant: "NTUC FairPrice", category: "groceries", cents: 6_215 }, ["alert", "apple_pay_shortcut"]);
	foreignOnHome({ account: A.citi, date: "2026-10-03", merchant: "Grab Malaysia", category: "transport", cur: "MYR", orig: 3_800, rate: 0.2961, markup: 0.0331, source: "learned", merchant_country: "MY" }, ["alert"], TRIP_KL);
	home({ account: A.hsbcA, date: "2026-10-05", merchant: "Netflix", category: "subscriptions", cents: 2_598 }, ["alert"]);

	// ------------------------------------------------------------ ranges, trips, subscriptions
	const RANGES: ReimburseRange[] = [
		{ id: "rr-demo-1", start_date: "2026-09-22", end_date: "2026-09-24", note: N.clientVisit },
		{ id: "rr-demo-2", start_date: "2026-08-04", end_date: "2026-08-06", note: N.bangkok },
	];

	const tripRow = (id: string, name: string | null, destination: string, countries: string[], start: string, end: string, status: TripRow["status"]): TripRow => ({
		id, name, destination, countries_json: JSON.stringify(countries), start_date: start, end_date: end, status, evidence_ids_json: "[]", confirmed_at: status === "confirmed" ? TS : null, created_at: TS, updated_at: TS,
	});
	const TRIPS = [
		tripRow(TRIP_JP, N.japan, "Tokyo, JP", ["JP"], "2026-09-12", "2026-09-19", "confirmed"),
		tripRow(TRIP_TPE, N.taipei, "Taipei, TW", ["TW"], "2026-07-09", "2026-07-12", "confirmed"),
		tripRow(TRIP_KL, null, "Kuala Lumpur, MY", ["MY"], "2026-10-02", "2026-10-04", "proposed"),
	];

	const sub = (id: string, name: string, currency: string, cadence: SubscriptionRow["cadence"], amount: number, prev: number | null, changed: string | null, first: string, last: string, next: string, n: number, status: SubscriptionRow["status"], owner: SubscriptionRow["owner_status"] = null): SubscriptionRow => ({
		id, merchant_key: name.toLowerCase().replace(/[^a-z0-9]+/g, ""), merchant_name: name, currency, cadence, amount_minor: amount, previous_amount_minor: prev, price_changed_on: changed, first_seen: first, last_charged: last, next_renewal: next, occurrences: n, status, owner_status: owner, line_ids_json: "[]", updated_at: TS,
	});
	const SUBS = [
		sub("sub-demo-netflix", "Netflix", "SGD", "monthly", 2_598, 2_298, "2026-09-02", "2025-11-02", "2026-10-05", "2026-11-02", 12, "active"),
		sub("sub-demo-gym", "Anytime Fitness", "SGD", "monthly", 9_800, null, null, "2026-08-07", "2026-10-07", "2026-11-07", 3, "active"),
		sub("sub-demo-openai", "OpenAI", "USD", "monthly", 2_000, null, null, "2025-03-10", "2026-09-10", "2026-10-10", 19, "active"),
		sub("sub-demo-spotify", "Spotify", "SGD", "monthly", 1_199, null, null, "2024-06-03", "2026-09-03", "2026-10-03", 28, "active"),
		sub("sub-demo-icloud", "Apple iCloud", "SGD", "monthly", 398, null, null, "2023-01-25", "2026-09-25", "2026-10-25", 45, "active"),
		sub("sub-demo-notion", "Notion", "USD", "yearly", 9_600, 9_600, null, "2024-11-20", "2025-11-20", "2026-11-20", 2, "active"),
		sub("sub-demo-disney", "Disney+", "SGD", "monthly", 1_198, null, null, "2025-01-14", "2026-05-14", "2026-06-14", 16, "lapsed"),
		sub("sub-demo-grab", "Grab Unlimited", "SGD", "monthly", 399, null, null, "2025-08-01", "2026-10-01", "2026-11-01", 15, "active", "ignored"),
	];

	// ------------------------------------------------------------ build the views
	const views = lines.map(({ row, ev, trip }) => lineView(row, byId.get(row.account_id)!, new Set(ev), RANGES, trip));
	views.sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1));
	const rowsIn = (from: string, to: string) => lines.map((l) => l.row).filter((r) => r.txn_date >= from && r.txn_date <= to && r.state !== "void");

	function overview(month: string) {
		const from = `${month}-01`;
		const to = month === "2026-09" ? "2026-09-30" : "2026-10-31";
		const rows = rowsIn(from, to);
		const asOf = to < TODAY ? to : TODAY;
		const group = (key: (r: LineRow) => string) => {
			const m = new Map<string, LineRow[]>();
			for (const r of rows.filter(isSpending)) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
			return [...m].map(([k, rs]) => ({ key: k, ...totals(rs) })).sort((a, b) => b.spending_home.minor - a.spending_home.minor);
		};
		const lastTap = (a: Account) =>
			lines.filter((l) => l.row.account_id === a.id && l.ev.includes("apple_pay_shortcut")).map((l) => l.row.txn_date).sort().at(-1) ?? null;
		// Exactly Dev's OverviewView (src/queries.ts).
		return {
			ok: true,
			month,
			from,
			to,
			totals: totals(rows),
			categories: group((r) => r.category ?? "Uncategorised").map(({ key, spending_home, unconfirmed_home, count }) => ({ category: key, spending_home, unconfirmed_home, count })),
			by_account: group((r) => r.account_id).map(({ key, spending_home, unconfirmed_home, count }) => ({ account_id: key, name: byId.get(key)!.name, spending_home, unconfirmed_home, count })),
			coverage: ACCOUNTS.map((a) => accountCoverage(a, STATEMENTS, lastTap(a), asOf)),
		};
	}

	const tripViews = TRIPS.map((t) => tripView(t, lines.filter((l) => l.trip === t.id).map((l) => l.row), RANGES));
	const subViews = SUBS.map(subscriptionView);
	const monthly = subViews
		.filter((s) => s.status === "active")
		.reduce((sum, s) => sum + (s.monthly_equivalent.currency === "SGD" ? s.monthly_equivalent.minor : convertMinor(s.monthly_equivalent.minor, s.monthly_equivalent.currency, "SGD", USD_SGD)), 0);
	const sept = views.filter((v) => v.date.startsWith(MONTH));

	const FIX: Record<string, unknown> = {
		overview: overview(MONTH),
		"overview.2026-10": overview("2026-10"),
		lines: { ok: true, lines: views, next_cursor: null },
		months: { ok: true, months: STATEMENTS.map(monthView) },
		accounts: { ok: true, accounts: ACCOUNTS.map((a) => ({ ...accountRef(a), currency: a.currency, active: true, wallet_names: [] })) },
		trips: { ok: true, trips: tripViews },
		subscriptions: { ok: true, subscriptions: subViews, monthly_total_home: money(monthly, "SGD"), monthly_total_missing: 0 },
		"reimbursable-ranges": { ok: true, ranges: RANGES },
		"needs-ok": (() => {
			const okTrips = tripViews.filter((t) => t.status === "proposed");
			const held_taps = [
				{ evidence_id: "ev-demo-held-1", card: "travelcard", merchant: "7-Eleven", amount: money(560, "SGD"), date: "2026-10-06", time: "21:14", received_at: "2026-10-06T13:14:09.000Z" },
			];
			const okLines = views.filter((v) => v.flags.some((f) => f !== "missed_by_alerts"));
			const months = STATEMENTS.filter((s) => s.recon_status === "escalated").map(monthView);
			return { ok: true, trips: okTrips, held_taps, lines: okLines, months, other_held: 1, count: okTrips.length + held_taps.length + okLines.length + months.length };
		})(),
		// POST responses — what the page gets back after an action
		"trip-confirm": { ok: true, trip: { ...tripViews.find((t) => t.id === TRIP_KL)!, status: "confirmed" }, lines: views.filter((v) => v.trip_id === TRIP_KL) },
		"trip-reject": { ok: true, trip: { ...tripViews.find((t) => t.id === TRIP_KL)!, status: "dismissed" }, lines: views.filter((v) => v.trip_id === TRIP_KL) },
		"line-reimbursable": { ok: true, line: views.find((v) => v.merchant.name === "Grab" && v.date === "2026-09-23")! },
		"reimbursable-ranges-post": { ok: true, range: RANGES[0], count: 3 },
		"range-delete": { ok: true, ranges: RANGES.slice(1), affected_lines: 3 },
		"subscription-action": { ok: true, subscriptions: subViews.map((v) => (v.id === "sub-demo-grab" ? { ...v, status: "active" as const } : v)), monthly_total_home: money(monthly + 399, "SGD"), monthly_total_missing: 0 },
		"wallet-names": { ok: true, wallet_key: "travelcard", account_id: A.hsbcB.id, recorded: 1, still_held: 0 },
		cash: { ok: true, line: views.find((v) => v.merchant.name === "Ichiran Ramen")! },
	};

	return { views: views.length, FIX };
}

const ALL: Record<string, Record<string, unknown>> = {};
let count = 0;
for (const lang of LANGUAGES) {
	const built = build(lang);
	ALL[lang] = { today: TODAY, month: MONTH, routes: built.FIX };
	count = built.views;
}
const FIX = (ALL.en as { routes: Record<string, unknown> }).routes;
for (const [name, body] of Object.entries(FIX)) writeFileSync(join(OUT, `${name}.json`), JSON.stringify(body, null, "\t") + "\n");
writeFileSync(
	join(OUT, "all.js"),
	"// Generated by make-fixtures.ts — MADE-UP data. Loaded only in ?fixtures=1 mode.\n" +
		"// One set per language; the page sets window.LEDGER_DEMO_LANG before loading this (English otherwise).\n" +
		`window.LEDGER_FIXTURES_BY_LANG = ${JSON.stringify(ALL)};\n` +
		"window.LEDGER_FIXTURES = window.LEDGER_FIXTURES_BY_LANG[window.LEDGER_DEMO_LANG] || window.LEDGER_FIXTURES_BY_LANG.en;\n",
);
console.log(`wrote ${Object.keys(FIX).length} fixtures, ${count} lines, in ${LANGUAGES.join(" and ")}`);
