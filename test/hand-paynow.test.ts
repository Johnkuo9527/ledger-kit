/// A DBS payment the owner wrote down by hand as CASH because DBS's email had not
/// come (15 Oct 2026: a PayNow for a drink, recorded as
/// 「飲料（DBS PayNow）」) must not count twice when DBS's own line arrives —
/// from the alert or from the statement. MADE-UP amounts and payees.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCash, ingestEvidence, ingestStatement, type EvidenceIn } from "../src/engine";
import type { LineRow } from "../src/types";
import { totals } from "../src/views";
import { BANK, CARD_C } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, testEngine } from "./helpers/world";
import type { Actor } from "../src/types";

/// An engine whose ids never repeat another's in the same test.
let engines = 0;
const eng = (actor: Actor = "rules") => {
	const k = ++engines;
	let n = 0;
	return { ...testEngine(db, actor), newId: () => `e${k}-${++n}` };
};

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
});
afterEach(() => db.close());

const lines = () => db.raw.prepare("SELECT * FROM lines ORDER BY created_at, id").all() as unknown as LineRow[];
const live = () => lines().filter((l) => l.state !== "void" && l.merged_into === null);
const get = (id: string) => db.raw.prepare("SELECT * FROM lines WHERE id = ?").get(id) as unknown as LineRow;
const paynow = (fp: string, over: Partial<EvidenceIn> = {}): EvidenceIn => ({
	type: "alert",
	institution: "dbs",
	last4: BANK.last4,
	fingerprint: fp,
	txn_date: "2026-10-15",
	txn_time: "13:05",
	currency: "SGD",
	amount_minor: 250,
	merchant_raw: "JANE TAN (Mobile ending 5678)",
	kind_hint: "transfer",
	authenticated: true,
	...over,
});
const drink = (over: Partial<Parameters<typeof addCash>[1]> = {}) =>
	addCash(eng("owner"), { txn_date: "2026-10-15", currency: "SGD", amount_minor: 250, merchant: "飲料（DBS PayNow）", category: "Drinks", note: "DBS sent only an app push", ...over });

describe("a hand-made cash line that was really a DBS PayNow", () => {
	it("joins the DBS alert's line when it arrives: counted once, the owner's category kept", async () => {
		const hand = await drink();
		expect(totals(lines()).spending_home.minor).toBe(250);
		const r = await ingestEvidence(eng(), paynow("pn1"));
		expect(r.status).toBe("created");
		const dbs = get((r as { line_id: string }).line_id);
		expect(dbs).toMatchObject({ account_id: BANK.id, kind: "purchase", category: "Drinks", home_minor: 250 });
		expect(get(hand.id)).toMatchObject({ state: "void", merged_into: dbs.id });
		// Counted once: S$2.50, not S$5.00.
		expect(totals(lines()).spending_home.minor).toBe(250);
		expect(live().map((l) => l.id)).toEqual([dbs.id]);
		// The hand line's evidence went along with it; both lines say what happened.
		expect(db.raw.prepare("SELECT line_id FROM evidence WHERE type = 'manual'").get()).toEqual({ line_id: dbs.id });
		const events = db.raw.prepare("SELECT line_id, actor, event FROM line_events WHERE event IN ('merged', 'category') ORDER BY id").all();
		expect(events).toEqual([
			{ line_id: dbs.id, actor: "owner", event: "category" },
			{ line_id: hand.id, actor: "rules", event: "merged" },
		]);
	});

	it("also when the DBS line comes from the statement (no alert was ever emailed)", async () => {
		const hand = await drink();
		const r = await ingestStatement(
			eng(),
			{ account_id: BANK.id, period_start: "2026-10-01", period_end: "2026-10-31", currency: "SGD", opening_balance_minor: 10_000, closing_balance_minor: 9_750, printed_net_minor: null },
			[{ seq: 1, txn_date: "2026-10-15", currency: "SGD", amount_minor: 250, merchant_raw: "PAYNOW TO JANE TAN", kind_hint: "transfer" }],
		);
		expect(r.status).toBe("imported");
		const dbs = live();
		expect(dbs).toHaveLength(1);
		expect(dbs[0]).toMatchObject({ account_id: BANK.id, category: "Drinks", kind: "purchase" });
		expect(get(hand.id)).toMatchObject({ state: "void", merged_into: dbs[0]!.id });
		expect(totals(lines()).spending_home.minor).toBe(250);
	});

	it("a PayNow to a shop keeps its purchase kind and takes the owner's category", async () => {
		await drink({ merchant: "Drinks", note: "paid by PayNow" });
		const r = await ingestEvidence(eng(), paynow("pn1", { merchant_raw: "KOPI CORNER PTE. LTD.", kind_hint: "purchase" }));
		expect(get((r as { line_id: string }).line_id)).toMatchObject({ kind: "purchase", category: "Drinks" });
		expect(live()).toHaveLength(1);
	});

	it("left alone: another amount, another day, cash that does not say DBS/PayNow, another bank, money in", async () => {
		await drink({ amount_minor: 260 });
		await drink({ txn_date: "2026-10-14" });
		await drink({ merchant: "飲料", note: "cash at the stall" });
		await ingestEvidence(eng(), paynow("pn1"));
		await ingestEvidence(eng(), paynow("in1", { amount_minor: -250, kind_hint: "income", merchant_raw: "JANE TAN" }));
		await ingestEvidence(eng(), { ...paynow("citi1"), institution: "citi", last4: CARD_C.last4, kind_hint: "purchase", merchant_raw: "DBS PAYNOW SHOP" });
		expect(lines().filter((l) => l.state === "void")).toEqual([]);
		expect(lines().filter((l) => l.account_id === "cash")).toHaveLength(3);
	});

	it("one hand line joins one DBS line: a second PayNow of the same amount that day stays its own line", async () => {
		const hand = await drink();
		const first = await ingestEvidence(eng(), paynow("pn1"));
		const second = await ingestEvidence(eng(), paynow("pn2", { txn_time: "18:40", merchant_raw: "ALEX LEE (Mobile ending 5679)" }));
		expect(second.status).toBe("created");
		expect(get(hand.id).merged_into).toBe((first as { line_id: string }).line_id);
		expect(get((second as { line_id: string }).line_id)).toMatchObject({ kind: "purchase", category: null });
		expect(live()).toHaveLength(2);
	});

	it("a payee the owner said is not spending (a friend's transfer) takes no hand line: his rule stands", async () => {
		db.raw.prepare("INSERT INTO payee_rules (merchant_key, kind, category, set_by, updated_at) VALUES ('JANE TAN', 'friend_transfer', NULL, 'owner', '2026-10-01T00:00:00.000Z')").run();
		const hand = await drink();
		const r = await ingestEvidence(eng(), paynow("pn1"));
		const dbs = get((r as { line_id: string }).line_id);
		expect(dbs.kind).toBe("friend_transfer");
		expect(get(hand.id).merged_into).toBeNull(); // only a DBS purchase takes a hand line
	});

	it("the same alert read again changes nothing more", async () => {
		const hand = await drink();
		await ingestEvidence(eng(), paynow("pn1"));
		expect(await ingestEvidence(eng(), paynow("pn1"))).toEqual({ status: "duplicate" });
		expect(get(hand.id).state).toBe("void");
		expect(live()).toHaveLength(1);
	});
});
