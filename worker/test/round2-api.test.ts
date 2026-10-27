/// round 2 part C, through the worker's real front door: every
/// 待確認 item's own buttons resolve it (meeting point A), the owner's card days
/// (C), 繳款 (D) — and the answers have the shapes the finished page reads
/// (page/fixtures/round2.js is the reference). Made-up data only.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidence, line, statement } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addRate, put } from "../../test/helpers/world";
import { handleRequest, type App } from "../src/app";
import type { LedgerEnv } from "../src/env";
import { CTX, get, json, makeDeps, makeEnv, post, seedWorld, signedIn, TEST_ASSETS, withLikeCap } from "./helpers/harness";

let raw: TestDb;
let env: LedgerEnv;
let app: App & { deps: ReturnType<typeof makeDeps> };
let cookie: string;
beforeEach(async () => {
	raw = freshDb();
	await seedWorld(raw);
	env = makeEnv(withLikeCap(raw));
	app = { assets: TEST_ASSETS, deps: makeDeps() };
	cookie = await signedIn();
});
afterEach(() => raw.close());

const send = (r: Request) => handleRequest(r, env, CTX, app);
const getJ = async (path: string) => json(await send(get(path, cookie)));
type Action = { id: string; label: string; method: string; path: string; body: Record<string, unknown>; style: string; choices?: { value: string }[]; choice_key?: string };
type Item = { actions?: Action[] };

/// Made-up items of every kind 待確認 lists, on top of the seeded world (a held tap, a proposed trip, an escalated month).
async function moreToConfirm() {
	const L = (over: Parameters<typeof line>[0]) => put(raw, "lines", line(over));
	await L({ id: "rv", account_id: "card-a", state: "review", txn_date: "2026-10-01", merchant_key: "ODD SHOP", merchant_name: "Odd Shop" });
	await L({ id: "nos", account_id: "card-a", flag_not_on_statement: 1, txn_date: "2026-09-01", merchant_key: "HOTEL HOLD", merchant_name: "Hotel Hold" });
	await L({ id: "orig", account_id: "card-b", txn_date: "2026-09-20", merchant_key: "GADGET STORE", merchant_name: "Gadget Store", orig_minor: 5000, bill_minor: 5000, home_minor: 5000 });
	await L({ id: "refund", account_id: "card-b", kind: "refund", flag_unlinked_refund: 1, txn_date: "2026-09-28", merchant_key: "GADGET STORE", merchant_name: "Gadget Store", orig_minor: -5000, bill_minor: -5000, home_minor: -5000 });
	await L({ id: "norate", account_id: "card-a", state: "review", flag_no_rate: 1, txn_date: "2026-10-07", orig_currency: "USD", orig_minor: 2000, bill_currency: "SGD", bill_minor: 0, bill_status: "estimate", home_minor: 0, home_status: "estimate" });
	await addRate(raw, "2026-10-07", "USD", 1.35); // the rate has arrived since
	await put(raw, "evidence", evidence({ id: "held-alert", type: "alert", fingerprint: "alert-held", txn_date: "2026-10-03", merchant_raw: "UNKNOWN MERCHANT" }));
	await put(raw, "statements", statement({ id: "st-bill", account_id: "card-b", period_start: "2026-08-21", period_end: "2026-09-20", recon_status: "reconciled", bill_check: "mismatch", bill_detail_json: JSON.stringify({ currency: "SGD", previous_minor: 100, payments_minor: 100, payments_printed_minor: 100, payment_lines_minor: 100, purchases_minor: 500, refunds_minor: 0, fees_minor: 0, computed_minor: 500, statement_balance_minor: 499, difference_minor: 1, line_count: 2 }) }));
	raw.raw.prepare("INSERT INTO alarms (key, message, raised_at) VALUES ('pdf_password:TAISHIN', 'A TAISHIN statement PDF would not open', '2026-10-08T00:00:00.000Z')").run();
	raw.raw.prepare("INSERT INTO work (gmail_id, source, kind, stage, attempts, not_before, error, created_at, updated_at) VALUES ('pw-1', 'daily', 'statement', 'waiting', 1, '2026-10-10T00:00:00.000Z', 'pdf password', 'x', 'x')").run();
}

describe("待確認: every item's own buttons resolve it", () => {
	it("each list's main action, POSTed as the page sends it, takes the item off the list", async () => {
		await moreToConfirm();
		const before = await getJ("/api/needs-ok");
		expect(before.ok).toBe(true);
		const lists = ["trips", "held_taps", "lines", "months", "held", "pdf_passwords"] as const;
		for (const k of lists) expect((before[k] as Item[]).length, k).toBeGreaterThan(0);
		for (const k of lists) {
			for (const item of before[k] as Item[]) {
				expect(item.actions?.length, `${k} has actions`).toBeGreaterThan(0);
				const a = item.actions![0]!;
				const body = { ...a.body, ...(a.choices?.length ? { [a.choice_key ?? "choice"]: a.choices[0]!.value } : {}) };
				const res = await send(post(a.path, body, cookie));
				const out = await json(res);
				expect([k, a.id, res.status, out.ok]).toEqual([k, a.id, 200, true]);
				if (k !== "trips" && k !== "held_taps") expect(typeof out.message).toBe("string");
			}
		}
		const after = await getJ("/api/needs-ok");
		for (const k of ["trips", "held_taps", "lines", "months", "held"] as const) expect([k, (after[k] as Item[]).length]).toEqual([k, 0]);
		// The PDF item stays until the statement opens; its button sent the waiting statement to be tried now.
		expect(raw.raw.prepare("SELECT not_before FROM work WHERE gmail_id = 'pw-1'").get()).toEqual({ not_before: null });
		// What each answer did, through the engine (logged as the owner's word).
		expect(raw.raw.prepare("SELECT id, state, refund_of, flag_no_rate, owner_ok FROM lines WHERE id IN ('rv', 'nos', 'refund', 'norate') ORDER BY id").all()).toEqual([
			{ id: "norate", state: "open", refund_of: null, flag_no_rate: 0, owner_ok: null },
			{ id: "nos", state: "open", refund_of: null, flag_no_rate: 0, owner_ok: "not_on_statement" },
			{ id: "refund", state: "open", refund_of: "orig", flag_no_rate: 0, owner_ok: "unlinked_refund" },
			{ id: "rv", state: "open", refund_of: null, flag_no_rate: 0, owner_ok: null },
		]);
		expect((raw.raw.prepare("SELECT bill_minor, home_minor FROM lines WHERE id = 'norate'").get() as { bill_minor: number }).bill_minor).toBeGreaterThan(2_000);
		expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM statements WHERE reviewed_at IS NOT NULL").get()).toEqual({ n: 2 });
		expect(raw.raw.prepare("SELECT dismissed_at IS NOT NULL AS d FROM evidence WHERE id = 'held-alert'").get()).toEqual({ d: 1 });
	});

	it("the other answers: void, a category with the OK, and a refusal said plainly", async () => {
		await moreToConfirm();
		let r = await json(await send(post("/api/lines/nos/review", { action: "void" }, cookie)));
		expect(r).toMatchObject({ ok: true, line: { id: "nos" } });
		expect(raw.raw.prepare("SELECT state FROM lines WHERE id = 'nos'").get()).toEqual({ state: "void" });
		r = await json(await send(post("/api/lines/rv/review", { action: "accept", category: "Dining" }, cookie)));
		expect(r.ok).toBe(true);
		expect(raw.raw.prepare("SELECT state, category FROM lines WHERE id = 'rv'").get()).toEqual({ state: "open", category: "Dining" });
		const bad = await send(post("/api/lines/refund/review", { action: "link", refund_of: "refund" }, cookie));
		expect(bad.status).toBe(400);
		expect((await json(bad)).ok).toBe(false);
		expect((await send(post("/api/lines/rv/review", { action: "explode" }, cookie))).status).toBe(400);
	});
});

describe("待確認: a card payment two bank transfers fit equally (25 Jun fix)", () => {
	it("the page's pick pairs the chosen transfer; the other stays spending", async () => {
		const L = (over: Parameters<typeof line>[0]) => put(raw, "lines", line(over));
		await L({ id: "citi-paid", account_id: "card-c", kind: "card_payment", state: "review", txn_date: "2026-06-25", orig_minor: -25_000, bill_minor: -25_000, home_minor: -25_000 });
		await L({ id: "t1", account_id: "bank-x", kind: "purchase", txn_date: "2026-06-25", merchant_raw: null, orig_minor: 25_000, bill_minor: 25_000, home_minor: 25_000 });
		await L({ id: "t2", account_id: "bank-x", kind: "purchase", txn_date: "2026-06-25", merchant_raw: "TAN AH-KXXX", orig_minor: 25_000, bill_minor: 25_000, home_minor: 25_000 });
		const ok = await getJ("/api/needs-ok");
		const item = (ok.lines as (Item & { id: string })[]).find((l) => l.id === "citi-paid")!;
		const a = item.actions![0]!;
		expect(a).toMatchObject({ id: "pair", choice_key: "line_id" });
		expect(a.choices!.map((c) => c.value)).toEqual(["t1", "t2"]);
		const r = await json(await send(post(a.path, { ...a.body, line_id: "t1" }, cookie)));
		expect(r).toMatchObject({ ok: true, line: { id: "citi-paid" } });
		expect(typeof r.message).toBe("string");
		const rows = raw.raw.prepare("SELECT id, kind, transfer_group IS NOT NULL AS paired FROM lines WHERE id IN ('citi-paid', 't1', 't2') ORDER BY id").all();
		expect(rows).toEqual([
			{ id: "citi-paid", kind: "card_payment", paired: 1 },
			{ id: "t1", kind: "card_payment", paired: 1 },
			{ id: "t2", kind: "purchase", paired: 0 },
		]);
		expect(((await getJ("/api/needs-ok")).lines as { id: string }[]).some((l) => l.id === "citi-paid")).toBe(false);
		const bad = await send(post("/api/lines/t2/review", { action: "pair", line_id: "t1" }, cookie));
		expect(bad.status).toBe(400);
	});
});

describe("card days (C)", () => {
	it("The owner's days win; both cleared goes back to the statements; only for a credit card", async () => {
		const r = await json(await send(post("/api/accounts/card-a/settings", { statement_day: 5, due_day: 25 }, cookie)));
		expect(r).toMatchObject({ ok: true, account: { id: "card-a", statement_day: 5, due_day: 25, settings_source: "owner" } });
		const accounts = (await getJ("/api/accounts")).accounts as Record<string, unknown>[];
		expect(accounts.find((a) => a.id === "card-a")).toMatchObject({ statement_day: 5, due_day: 25, settings_source: "owner" });
		expect(accounts.find((a) => a.id === "bank-x")).toMatchObject({ statement_day: null, due_day: null, settings_source: null });
		const back = await json(await send(post("/api/accounts/card-a/settings", { statement_day: null, due_day: null }, cookie)));
		expect(back).toMatchObject({ ok: true, account: { statement_day: 15, settings_source: "statement" } }); // the seeded statement ends on the 15th
		expect((await send(post("/api/accounts/card-a/settings", { statement_day: 32 }, cookie))).status).toBe(400);
		expect((await send(post("/api/accounts/bank-x/settings", { statement_day: 3 }, cookie))).status).toBe(400);
	});
});

describe("繳款 (D)", () => {
	it("per card: the bill, paid since, what is left, by when; and a total row", async () => {
		raw.raw.prepare("UPDATE accounts SET due_day = 3 WHERE id = 'card-b'").run();
		await put(raw, "statements", statement({ id: "bill-a", account_id: "card-a", period_start: "2026-08-26", period_end: "2026-09-25", previous_balance_minor: 98_000, statement_balance_minor: 241_755, minimum_due_minor: 5_000, payments_credited_minor: 98_000, due_date: "2026-10-15", bill_check: "ok", recon_status: "reconciled" }));
		await put(raw, "lines", line({ id: "pay-a", account_id: "card-a", kind: "card_payment", txn_date: "2026-10-01", orig_minor: -100_000, bill_minor: -100_000, home_minor: -100_000 }));
		await put(raw, "statements", statement({ id: "bill-b", account_id: "card-b", period_start: "2026-08-21", period_end: "2026-09-20", opening_balance_minor: 0, closing_balance_minor: 30_000, recon_status: "reconciled" }));
		const p = await getJ("/api/payments");
		expect(p.ok).toBe(true);
		const cards = p.cards as Record<string, any>[];
		const a = cards.find((c) => c.account.id === "card-a")!;
		expect(a).toMatchObject({
			last_statement: { period_from: "2026-08-26", period_to: "2026-09-25", statement_balance: { minor: 241_755 }, minimum_due: { minor: 5_000 }, due_date: "2026-10-15", previous_balance: { minor: 98_000 }, payments_credited: { minor: 98_000 } },
			paid_since_statement: { minor: 100_000 },
			outstanding: { minor: 141_755, currency: "SGD" },
			due_date: "2026-10-15",
			days_left: 6,
			status: "due",
			reconciliation: { status: "reconciled" },
		});
		expect(a.unbilled.minor).toBeGreaterThan(0); // the seeded taps after the cut-off
		// A bill that printed no due date: the card's due day after its cut-off; already past → overdue.
		const b = cards.find((c) => c.account.id === "card-b")!;
		expect(b).toMatchObject({ outstanding: { minor: 30_000 }, due_date: "2026-10-03", days_left: -6, status: "overdue" });
		expect(cards[0]!.status).toBe("overdue"); // the most urgent first
		expect(p.total).toMatchObject({ outstanding_home: { currency: "SGD", minor: 171_755 }, minimum_due_home: { currency: "SGD" }, unbilled_home: { currency: "SGD" } });
	});
});

// ------------------------------------------------------------ the page's shapes

/// The page's round-2 fixtures, evaluated as the page loads them (all.js, then round2.js).
function pageFixtures(): Record<string, any> {
	const dir = new URL("../../page/fixtures/", import.meta.url);
	const window: { LEDGER_FIXTURES?: { routes: Record<string, any> } } = {};
	runInNewContext(readFileSync(new URL("all.js", dir), "utf8") + "\n" + readFileSync(new URL("round2.js", dir), "utf8"), { window });
	return window.LEDGER_FIXTURES!.routes;
}

/// Every field the fixture has, the API answer has too, with the same kind of value (first item of each list).
function sameShape(fixture: unknown, api: unknown, at: string): string[] {
	const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
	if (fixture === null || api === null) return []; // either may be absent-as-null (a card with no bill yet)
	if (kind(fixture) !== kind(api)) return [`${at}: page expects ${kind(fixture)}, API gives ${kind(api)}`];
	if (Array.isArray(fixture)) return fixture.length && (api as unknown[]).length ? sameShape(fixture[0], (api as unknown[])[0], `${at}[0]`) : [];
	if (kind(fixture) !== "object") return [];
	const out: string[] = [];
	for (const [k, v] of Object.entries(fixture as Record<string, unknown>)) {
		if (!(k in (api as Record<string, unknown>))) out.push(`${at}.${k}: missing from the API`);
		else out.push(...sameShape(v, (api as Record<string, unknown>)[k], `${at}.${k}`));
	}
	return out;
}

describe("the answers have the shapes the finished page reads (page/fixtures/round2.js)", () => {
	it("payments, card days, and 待確認 actions", async () => {
		const F = pageFixtures();
		await moreToConfirm();
		await put(raw, "statements", statement({ id: "bill-a", account_id: "card-a", period_start: "2026-08-26", period_end: "2026-09-25", previous_balance_minor: 98_000, statement_balance_minor: 241_755, minimum_due_minor: 5_000, payments_credited_minor: 98_000, due_date: "2026-10-15" }));
		const pay = await getJ("/api/payments");
		const withBill = (pay.cards as Record<string, unknown>[]).filter((c) => c.last_statement);
		expect(sameShape({ ...F.payments, cards: [F.payments.cards[0]] }, { ...pay, cards: withBill }, "payments")).toEqual([]);

		const accounts = (await getJ("/api/accounts")).accounts as Record<string, unknown>[];
		const card = F.accounts.accounts.find((a: { kind: string }) => a.kind === "credit_card");
		expect(sameShape(card, accounts.find((a) => a.kind === "credit_card"), "accounts")).toEqual([]);

		const n = await getJ("/api/needs-ok");
		const fx = F["needs-ok"];
		expect(sameShape(fx.held_taps[0].actions[0], (n.held_taps as Item[])[0]!.actions![0], "held_taps.actions")).toEqual([]);
		expect(sameShape(fx.months[0].actions[0], (n.months as Item[])[0]!.actions![0], "months.actions")).toEqual([]);
		const pdfFixture = { ...fx.pdf_passwords[0] };
		expect(sameShape(pdfFixture, (n.pdf_passwords as unknown[])[0], "pdf_passwords")).toEqual([]);
		const lineAct = (Object.values(fx.line_actions)[0] as Action[])[0];
		expect(sameShape(lineAct, (n.lines as Item[])[0]!.actions![0], "lines.actions")).toEqual([]);
		// A choice is {value, label}.
		expect(sameShape(fx.held_taps[0].actions[0].choices[0], (n.held_taps as Item[])[0]!.actions![0]!.choices![0], "choice")).toEqual([]);
	});
});

describe("繳款: no 逾期 without evidence (14 Oct 2026)", () => {
	const billB = () => statement({ id: "bill-b", account_id: "card-b", period_start: "2026-08-21", period_end: "2026-09-20", statement_balance_minor: 30_000, due_date: "2026-10-03", recon_status: "reconciled" });
	const cardOf = async (id: string) => ((await getJ("/api/payments")).cards as Record<string, any>[]).find((c) => c.account.id === id)!;

	it("「我已繳款」 from 待確認 marks the bill paid by the owner's word; false takes it back", async () => {
		await put(raw, "statements", billB());
		expect(await cardOf("card-b")).toMatchObject({ status: "overdue", status_reason: "no_payment_seen" });
		const items = (await getJ("/api/needs-ok")).bills as Item[];
		expect(items.length).toBe(1);
		const a = items[0]!.actions![0]!;
		expect([a.label, a.path, a.body]).toEqual(["我已繳款", "/api/payments/bill-b/paid", { paid: true }]);
		const r = await json(await send(post(a.path, a.body, cookie)));
		expect(r).toMatchObject({ ok: true, card: { account: { id: "card-b" }, status: "paid", paid_source: "owner" } });
		expect(typeof r.message).toBe("string");
		expect((await getJ("/api/needs-ok")).bills).toEqual([]);
		await send(post("/api/payments/bill-b/paid", { paid: false }, cookie));
		expect(await cardOf("card-b")).toMatchObject({ status: "overdue" });
		expect((await send(post("/api/payments/bill-b/paid", {}, cookie))).status).toBe(400);
		expect((await send(post("/api/payments/no-such/paid", { paid: true }, cookie))).status).toBe(400);
	});

	it("autopay on the card settings: the owner's word, alone or with the days; only for a credit card", async () => {
		await put(raw, "statements", billB());
		const r = await json(await send(post("/api/accounts/card-b/settings", { autopay: true }, cookie)));
		expect(r).toMatchObject({ ok: true, account: { id: "card-b", autopay: true, settings_source: null } });
		expect(await cardOf("card-b")).toMatchObject({ status: "autopay_pending", autopay: { on: true, source: "owner" } });
		await send(post("/api/accounts/card-b/settings", { autopay: null }, cookie));
		expect(((await getJ("/api/accounts")).accounts as Record<string, unknown>[]).find((a) => a.id === "card-b")).toMatchObject({ autopay: null });
		expect((await send(post("/api/accounts/bank-x/settings", { autopay: true }, cookie))).status).toBe(400);
		expect((await send(post("/api/accounts/card-b/settings", {}, cookie))).status).toBe(400);
	});

	it("the next statement shows the bill unpaid: a 待確認 item the page can draw; 「知道了」 takes it off", async () => {
		const F = pageFixtures();
		await put(raw, "statements", statement({ id: "c-aug", account_id: "card-c", period_start: "2026-07-31", period_end: "2026-08-30", statement_balance_minor: 43_210, due_date: "2026-09-25", recon_status: "reconciled" }));
		await put(raw, "statements", statement({ id: "c-sep", account_id: "card-c", period_start: "2026-08-31", period_end: "2026-09-30", previous_balance_minor: 43_210, payments_credited_minor: 20_000, statement_balance_minor: 61_377, due_date: "2026-10-25", recon_status: "reconciled" }));
		expect(await cardOf("card-c")).toMatchObject({ status: "overdue", status_reason: "previous_unpaid", previous_bill: { statement_id: "c-aug", verdict: "unpaid" } });
		const items = (await getJ("/api/needs-ok")).bills as Item[];
		expect(sameShape(F["needs-ok"].bills[0], items[0], "bills")).toEqual([]);
		expect(sameShape({ ...F.payments.cards.find((c: { status_reason?: string }) => c.status_reason === "previous_unpaid") }, await cardOf("card-c"), "payments.previous_unpaid")).toEqual([]);
		const r = await json(await send(post(items[0]!.actions![0]!.path, {}, cookie)));
		expect(r.ok).toBe(true);
		expect((await getJ("/api/needs-ok")).bills).toEqual([]);
	});
});
