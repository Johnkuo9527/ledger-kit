/// live 25 Jun: a Citi card's "payment received" S$250, and two S$250
/// transfers out of DBS that day — one with no payee (the real card payment),
/// one to a person whose name the bank masked ("TAN AH-KXXX"). The ledger
/// paired the PERSON. The owner's rule now: by amount alone a payee that reads as a
/// person is never matched, no payee beats bank words, equally good = 待確認
/// for the owner to pick, and his own word is never undone. MADE-UP amounts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestEvidence, lookBackPayments, reviewLine, undoAmountMatches } from "../src/engine";
import { needsOk } from "../src/queries";
import { decideCardPaymentByAmount, findCardPaymentByAmount, readPayee } from "../src/transfers";
import { BANK, CARD_C, line } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, put, testEngine } from "./helpers/world";

const banks = new Set([BANK.id]);
const card = (over = {}) => line({ id: "citi-paid", account_id: CARD_C.id, kind: "card_payment", bill_minor: -25_000, orig_minor: -25_000, home_minor: -25_000, txn_date: "2026-06-25", ...over });
const bankOut = (id: string, merchant_raw: string | null, over = {}) =>
	line({ id, account_id: BANK.id, kind: "purchase", bill_minor: 25_000, orig_minor: 25_000, home_minor: 25_000, txn_date: "2026-06-25", merchant_raw, ...over });

describe("readPayee", () => {
	it.each([
		[null, "none"],
		["", "none"],
		[" - ", "none"],
		["IBG 0012345", "bank"],
		["FUNDS TRF TO CITIBANK", "bank"],
		["BILL PAYMENT CITI 3333", "bank"],
		["轉帳繳款 台新銀行", "bank"],
		["TAN AH-KXXX", "person"],
		["TAXX MEIXXX", "person"],
		["JANE TAN", "person"],
		["PAYNOW TO JANE TAN", "person"],
		["PAYNOW", "person"],
		["T. RECEPTION PTE. LTD.", "person"],
	])("%s → %s", (raw, want) => {
		expect(readPayee(raw)).toBe(want);
	});
});

describe("decideCardPaymentByAmount (the 25 Jun case)", () => {
	it("the no-payee line is the card payment, never the masked name", () => {
		const tan = bankOut("tan", "TAN AH-KXXX");
		const blank = bankOut("blank", null);
		expect(findCardPaymentByAmount(card(), banks, [tan, blank])?.id).toBe("blank");
		expect(findCardPaymentByAmount(card(), banks, [blank, tan])?.id).toBe("blank");
	});

	it("a person's transfer never finds the card payment by amount alone, even when it is the only one", () => {
		expect(findCardPaymentByAmount(bankOut("tan", "TAN AH-KXXX"), banks, [card()])).toBeNull();
		expect(findCardPaymentByAmount(card(), banks, [bankOut("tan", "TAN AH-KXXX")])).toBeNull();
	});

	it("no payee beats bank words, even a day further away", () => {
		const ibg = bankOut("ibg", "IBG 0012345");
		const blank = bankOut("blank", null, { txn_date: "2026-06-26" });
		expect(findCardPaymentByAmount(card(), banks, [ibg, blank])?.id).toBe("blank");
	});

	it("two equally good: no pick, both handed back for the owner", () => {
		const d = decideCardPaymentByAmount(card(), banks, [bankOut("b1", null), bankOut("b2", null), bankOut("tan", "TAN AH-KXXX")]);
		expect(d.pick).toBeNull();
		expect(d.tied.map((c) => c.id)).toEqual(["b1", "b2"]);
	});
});

describe("in the ledger", () => {
	let db: TestDb;
	beforeEach(async () => {
		db = freshDb();
		await addAccounts(db);
	});
	afterEach(() => db.close());

	const row = (id: string) => db.raw.prepare("SELECT kind, state, transfer_group, counter_account_id, owner_ok FROM lines WHERE id = ?").get(id) as Record<string, unknown>;
	const alert = (e: ReturnType<typeof testEngine>, fp: string, merchant_raw: string | null) =>
		ingestEvidence(e, { type: "alert", institution: "dbs", last4: BANK.last4, fingerprint: fp, txn_date: "2026-06-25", currency: "SGD", amount_minor: 25_000, merchant_raw, kind_hint: "transfer" });
	const idOf = (fp: string) => (db.raw.prepare("SELECT line_id FROM evidence WHERE fingerprint = ?").get(fp) as { line_id: string }).line_id;

	it("the person's alert arriving first does not take the card payment; the no-payee one does", async () => {
		await put(db, "lines", card());
		const e = testEngine(db);
		await alert(e, "tan", "TAN AH-KXXX");
		await alert(e, "blank", null);
		expect(row(idOf("tan"))).toMatchObject({ kind: "purchase", transfer_group: null });
		expect(row(idOf("blank"))).toMatchObject({ kind: "card_payment", counter_account_id: CARD_C.id });
		expect(row(idOf("blank")).transfer_group).toBe(row("citi-paid").transfer_group);
	});

	it("two no-payee lines: neither changed, the card's line waits in 待確認 with a pick, and the owner's pick holds", async () => {
		await put(db, "lines", card());
		await put(db, "lines", bankOut("b1", null, { created_at: "2026-06-25T01:00:00.000Z" }));
		await put(db, "lines", bankOut("b2", null, { created_at: "2026-06-25T02:00:00.000Z" }));
		await lookBackPayments(testEngine(db), null, 50);
		expect(row("b1")).toMatchObject({ kind: "purchase", transfer_group: null });
		expect(row("b2")).toMatchObject({ kind: "purchase", transfer_group: null });
		expect(row("citi-paid")).toMatchObject({ state: "review", transfer_group: null });

		const ok = await needsOk(db);
		const item = ok.lines.find((l) => l.id === "citi-paid")!;
		const pair = item.actions.find((a) => a.id === "pair")!;
		expect(pair).toMatchObject({ choice_key: "line_id", body: { action: "pair" } });
		expect(pair.choices!.map((c) => c.value)).toEqual(["b1", "b2"]);

		await reviewLine(testEngine(db), "citi-paid", "pair", { line_id: "b2" });
		expect(row("b2")).toMatchObject({ kind: "card_payment", counter_account_id: CARD_C.id });
		expect(row("b2").transfer_group).toBe(row("citi-paid").transfer_group);
		expect(row("citi-paid")).toMatchObject({ state: "open" });
		expect(row("b1")).toMatchObject({ kind: "purchase", transfer_group: null });

		// The look back and the undo leave the owner's pick alone.
		await lookBackPayments(testEngine(db), null, 50);
		expect(await undoAmountMatches(testEngine(db), null, 50)).toEqual({ next: null, changed: 0 });
		expect(row("b2")).toMatchObject({ kind: "card_payment" });
	});

	it("'leave it' is never asked again", async () => {
		await put(db, "lines", card());
		await put(db, "lines", bankOut("b1", null));
		await put(db, "lines", bankOut("b2", null));
		await lookBackPayments(testEngine(db), null, 50);
		await reviewLine(testEngine(db), "citi-paid", "accept");
		expect(row("citi-paid")).toMatchObject({ state: "open", owner_ok: "payment_pick" });
		await lookBackPayments(testEngine(db), null, 50);
		expect(row("citi-paid")).toMatchObject({ state: "open" });
	});

	it("a bank line whose kind the owner set is never one of the candidates", async () => {
		await put(db, "lines", card());
		await put(db, "lines", bankOut("owners", null));
		db.raw.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) VALUES ('owners', 'x', 'owner', 'kind', '{\"kind\":\"card_payment\"}', '{\"kind\":\"purchase\"}')").run();
		await put(db, "lines", bankOut("b2", null));
		await lookBackPayments(testEngine(db), null, 50);
		expect(row("owners")).toMatchObject({ kind: "purchase", transfer_group: null });
		expect(row("b2")).toMatchObject({ kind: "card_payment" });
	});

	describe("the undo of matches made under the old rule", () => {
		const oldMatch = async (bankId: string, group: string) => {
			db.raw.prepare("UPDATE lines SET kind = 'card_payment', counter_account_id = ?, transfer_group = ? WHERE id = ?").run(CARD_C.id, group, bankId);
			db.raw.prepare("UPDATE lines SET transfer_group = ?, counter_account_id = ? WHERE id = 'citi-paid'").run(group, BANK.id);
			const ev = db.raw.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) VALUES (?, '2026-06-26T00:00:00.000Z', 'rules', ?, ?, ?)");
			ev.run(bankId, "card_payment_by_amount", JSON.stringify({ kind: "purchase", counter_account_id: null }), JSON.stringify({ kind: "card_payment", counter_account_id: CARD_C.id }));
			ev.run(bankId, "pair_transfer", JSON.stringify({ transfer_group: null }), JSON.stringify({ transfer_group: group }));
			ev.run("citi-paid", "pair_transfer", JSON.stringify({ transfer_group: null, counter_account_id: null }), JSON.stringify({ transfer_group: group, counter_account_id: BANK.id }));
		};

		it("the masked name goes back to spending, the no-payee line becomes the card payment, all logged", async () => {
			await put(db, "lines", card());
			await put(db, "lines", bankOut("tan", "TAN AH-KXXX"));
			await put(db, "lines", bankOut("blank", null));
			await oldMatch("tan", "g-old");
			const r = await undoAmountMatches(testEngine(db), null, 50);
			expect(r).toEqual({ next: null, changed: 1 });
			expect(row("tan")).toMatchObject({ kind: "purchase", transfer_group: null, counter_account_id: null });
			expect(row("blank")).toMatchObject({ kind: "card_payment", counter_account_id: CARD_C.id });
			expect(row("blank").transfer_group).toBe(row("citi-paid").transfer_group);
			expect(row("citi-paid").transfer_group).not.toBe("g-old");
			expect(db.raw.prepare("SELECT line_id, actor FROM line_events WHERE event = 'undo_card_payment_by_amount' ORDER BY line_id").all()).toEqual([
				{ line_id: "citi-paid", actor: "rules" },
				{ line_id: "tan", actor: "rules" },
			]);
			// Run again: nothing more to undo.
			expect(await undoAmountMatches(testEngine(db), null, 50)).toEqual({ next: null, changed: 0 });
		});

		it("a match today's rule would make too is kept", async () => {
			await put(db, "lines", card());
			await put(db, "lines", bankOut("ibg", "IBG 0012345"));
			await oldMatch("ibg", "g-old");
			expect(await undoAmountMatches(testEngine(db), null, 50)).toEqual({ next: null, changed: 0 });
			expect(row("ibg")).toMatchObject({ kind: "card_payment", transfer_group: "g-old" });
		});

		it("a line the owner touched is never undone", async () => {
			await put(db, "lines", card());
			await put(db, "lines", bankOut("tan", "TAN AH-KXXX"));
			await oldMatch("tan", "g-old");
			db.raw.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) VALUES ('tan', 'x', 'owner', 'kind', '{\"kind\":\"purchase\"}', '{\"kind\":\"card_payment\"}')").run();
			expect(await undoAmountMatches(testEngine(db), null, 50)).toEqual({ next: null, changed: 0 });
			expect(row("tan")).toMatchObject({ kind: "card_payment", transfer_group: "g-old" });
		});

		it("two equally good after the undo: the card's line waits for the owner", async () => {
			await put(db, "lines", card());
			await put(db, "lines", bankOut("tan", "TAN AH-KXXX"));
			await put(db, "lines", bankOut("b1", null));
			await put(db, "lines", bankOut("b2", null));
			await oldMatch("tan", "g-old");
			await undoAmountMatches(testEngine(db), null, 50);
			expect(row("tan")).toMatchObject({ kind: "purchase", transfer_group: null });
			expect(row("citi-paid")).toMatchObject({ state: "review", transfer_group: null, counter_account_id: null });
			expect(row("b1")).toMatchObject({ kind: "purchase" });
		});
	});
});
