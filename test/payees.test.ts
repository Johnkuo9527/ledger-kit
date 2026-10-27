/// The owner's payee rules (round 2, addition 2): his word on what money paid
/// to a payee IS — investment, loan repayment, a friend's transfer, his own
/// transfer, a card bill, or spending (with a category) — beats detection,
/// for new lines, old lines (the look back) and at once when he says it.
/// MADE-UP names, accounts and amounts throughout.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLine, ingestEvidence, lookBackRules, pairPayment, payeeRules, setLineKind, setPayeeRule } from "../src/engine";
import { merchantKey } from "../src/merchant";
import { isTransferLine, ownerKind, kindsMatch, kindUnder, ruleChanges, ruleFor, ruleForLine } from "../src/payees";
import { overview } from "../src/queries";
import { isSpending } from "../src/transfers";
import { ACCOUNTS, BANK, CARD_A, CARD_C, DEBIT, line } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, put, testEngine } from "./helpers/world";

const r = (merchant_key: string, kind: string | null = null, category: string | null = null) => ({ merchant_key, kind, category, set_by: "owner", updated_at: "2026-10-01T00:00:00.000Z" }) as const;

describe("which rule covers a merchant", () => {
	const rules = [r("ACME BROKER CLIENTS", "investment"), r("TAN AH KOW", "friend_transfer"), r("JANE", "friend_transfer"), r("JANE ROE", "purchase", "Rent")];

	it("a key that starts with the rule's words; the longest rule wins", () => {
		expect(ruleFor("ACME BROKER CLIENTS", rules)?.merchant_key).toBe("ACME BROKER CLIENTS");
		expect(ruleFor("JANE MOBILE ENDING", rules)?.merchant_key).toBe("JANE");
		expect(ruleFor("JANE ROE PAYNOW", rules)?.merchant_key).toBe("JANE ROE");
		expect(ruleFor("JANES CAFE", rules)).toBeNull(); // a whole word, not a part of one
		expect(ruleFor("THE ACME BROKER CLIENTS", rules)).toBeNull();
		expect(ruleFor(null, rules)).toBeNull();
	});

	it("a bank's masked name fits a rule letter for letter on the letters it shows", () => {
		expect(ruleFor("TAX AH KXX", rules)?.merchant_key).toBe("TAN AH KOW");
		expect(ruleFor("TXX AH KXX PAYNOW MOBILE ENDING", rules)?.merchant_key).toBe("TAN AH KOW");
		expect(ruleFor("TAX AH KXXX", rules)).toBeNull(); // a different length is a different name
		expect(ruleFor("TAB AH KXX", rules)).toBeNull(); // a letter shown that differs
	});

	it("a masked name two rules could be is left alone", () => {
		const two = [r("TAN AH KOW", "friend_transfer"), r("TAN AH KOK", "investment")];
		expect(ruleFor("TAN AH KOX", two)).toBeNull();
		expect(ruleFor("TAN AH KOW", two)?.merchant_key).toBe("TAN AH KOW"); // an unmasked name is still exact
	});

	it("The owner's words for kinds", () => {
		expect(ownerKind("spending")).toBe("purchase");
		expect(ownerKind("own_transfer")).toBe("transfer");
		expect(ownerKind("Investment")).toBe("investment");
		expect(ownerKind("fee")).toBeNull();
	});

	it("what a rule moves: spending stays a purchase (money back = refund); fees, rebates and offsets are never moved", () => {
		expect(kindUnder({ kind: "purchase", bill_minor: 100 }, "investment")).toBe("investment");
		expect(kindUnder({ kind: "income", bill_minor: -100 }, "investment")).toBe("investment");
		expect(kindUnder({ kind: "investment", bill_minor: 100 }, "purchase")).toBe("purchase");
		expect(kindUnder({ kind: "friend_transfer", bill_minor: -100 }, "purchase")).toBe("refund");
		expect(kindUnder({ kind: "purchase", bill_minor: 100 }, "purchase")).toBeNull();
		expect(kindUnder({ kind: "fee", bill_minor: 100 }, "investment")).toBeNull();
		expect(kindUnder({ kind: "refund", bill_minor: -100, income_offset: "card" }, "friend_transfer")).toBeNull();
		expect(ruleChanges({ kind: "purchase", bill_minor: 100, category: "Others" }, { kind: "purchase", category: "Rent" })).toEqual({ category: "Rent" });
		expect(ruleChanges({ kind: "purchase", bill_minor: 100, category: "Others" }, { kind: "purchase", category: "Rent" }, true)).toEqual({});
		expect(ruleChanges({ kind: "purchase", bill_minor: 100, category: null }, { kind: "investment", category: null })).toEqual({ kind: "investment" });
	});

	it("a re-kinded line still takes the alert or statement line that reads it as a payment", () => {
		expect(kindsMatch("investment", "purchase")).toBe(true);
		expect(kindsMatch("friend_transfer", "income")).toBe(true);
		expect(kindsMatch("purchase", "investment")).toBe(true); // filed before the rule; the look back fixes its kind
		expect(kindsMatch("purchase", "refund")).toBe(false);
	});

	it("never spending", () => {
		for (const kind of ["investment", "loan_repayment", "friend_transfer"] as const) expect(isSpending({ kind, state: "posted" })).toBe(false);
	});
});

describe("in the ledger", () => {
	let db: TestDb;
	beforeEach(async () => {
		db = freshDb();
		await addAccounts(db);
		db.raw.prepare("DELETE FROM payee_rules").run(); // the tests' own made-up rules only
	});
	afterEach(() => db.close());

	const addRule = (key: string, kind: string | null, category: string | null = null, at = "2026-10-01T00:00:00.000Z") =>
		db.raw.prepare("INSERT INTO payee_rules (merchant_key, kind, category, set_by, updated_at) VALUES (?, ?, ?, 'owner', ?)").run(key, kind, category, at);
	const row = (id: string) => db.raw.prepare("SELECT kind, category, transfer_group FROM lines WHERE id = ?").get(id) as { kind: string; category: string | null; transfer_group: string | null };
	const alert = (fingerprint: string, merchant_raw: string, amount_minor: number, txn_date = "2026-03-10") =>
		({ type: "alert", institution: "dbs", last4: BANK.last4, fingerprint, txn_date, currency: "SGD", amount_minor, merchant_raw, kind_hint: "transfer" }) as const;

	it("a fresh database starts with no payee rules: each household adds its own", () => {
		const fresh = freshDb();
		const seeded = fresh.raw.prepare("SELECT COUNT(*) AS n FROM payee_rules").get() as { n: number };
		fresh.close();
		expect(seeded.n).toBe(0);
	});

	it("a new alert to an investment payee is an investment, never spending", async () => {
		addRule("ACME BROKER CLIENTS", "investment");
		const res = await ingestEvidence(testEngine(db), alert("a1", "ACME BROKER -CLIENTS", 150_000));
		expect(res.status).toBe("created");
		const id = (res as { line_id: string }).line_id;
		expect(row(id).kind).toBe("investment");
	});

	it("a line the owner re-kinded by hand still takes the receipt that reads it as a purchase", async () => {
		await put(db, "lines", line({ id: "inv", account_id: BANK.id, kind: "investment", merchant_raw: "ACME BROKER CLIENTS", merchant_key: "ACME BROKER CLIENTS", bill_minor: 150_000, orig_minor: 150_000, home_minor: 150_000, txn_date: "2026-03-10" }));
		const st = await ingestEvidence(testEngine(db), { type: "receipt", fingerprint: "rc1", txn_date: "2026-03-10", currency: "SGD", amount_minor: 150_000, merchant_raw: "ACME BROKER CLIENTS" });
		expect(st).toMatchObject({ status: "attached", line_id: "inv" });
		expect(row("inv").kind).toBe("investment");
	});

	it("a rent payee: spending, in its category", async () => {
		addRule("JANE ROE", "purchase", "Rent");
		const res = await ingestEvidence(testEngine(db), alert("a3", "JANE ROE", 200_000));
		expect(row((res as { line_id: string }).line_id)).toMatchObject({ kind: "purchase", category: "Rent" });
	});

	it("a ruled bank payment is never turned into a card bill by amount", async () => {
		addRule("JANE ROE", "purchase", "Rent");
		await put(db, "lines", line({ id: "card-leg", account_id: CARD_C.id, kind: "card_payment", bill_minor: -200_000, orig_minor: -200_000, home_minor: -200_000, txn_date: "2026-03-11" }));
		await put(db, "lines", line({ id: "rent", account_id: BANK.id, kind: "purchase", merchant_raw: "JANE ROE", merchant_key: "JANE ROE", bill_minor: 200_000, orig_minor: 200_000, home_minor: 200_000, txn_date: "2026-03-10" }));
		const e = testEngine(db);
		await pairPayment(e, (await getLine(db, "card-leg"))!, null, ACCOUNTS);
		expect(row("rent").kind).toBe("purchase");
		expect(row("card-leg").transfer_group).toBeNull();
	});

	it("The owner's rule for a payee moves its old lines at once — masked names too — and unpairs a transfer", async () => {
		addRule("TAN AH KOW", null, "Food"); // an older rule naming another payee: left as it is
		await put(db, "lines", line({ id: "k1", account_id: BANK.id, kind: "purchase", merchant_key: "BO LIM", bill_minor: 5_000, home_minor: 5_000 }));
		await put(db, "lines", line({ id: "k2", account_id: BANK.id, kind: "transfer", merchant_key: "BO LIM PAYNOW", bill_minor: 7_000, home_minor: 7_000, transfer_group: "g1" }));
		await put(db, "lines", line({ id: "k3", account_id: CARD_C.id, kind: "transfer", merchant_key: "OWN", bill_minor: -7_000, home_minor: -7_000, transfer_group: "g1" }));
		await put(db, "lines", line({ id: "k4", account_id: BANK.id, kind: "income", merchant_key: "BX LXM", bill_minor: -3_000, home_minor: -3_000 }));
		await put(db, "lines", line({ id: "z", account_id: BANK.id, kind: "purchase", merchant_key: "OTHER", bill_minor: 1_000 }));
		const e = testEngine(db, "owner");
		const out = await setPayeeRule(e, "BO LIM", { kind: "friend_transfer" });
		expect(out.changed).toBe(4); // k1, k2, k4 — and k3 left the pair
		expect(row("k1").kind).toBe("friend_transfer");
		expect(row("k2")).toMatchObject({ kind: "friend_transfer", transfer_group: null });
		expect(row("k3")).toMatchObject({ kind: "transfer", transfer_group: null });
		expect(row("k4").kind).toBe("friend_transfer");
		expect(row("z").kind).toBe("purchase");
		expect((await payeeRules(testEngine(db))).find((x) => x.merchant_key === "BO LIM")).toMatchObject({ kind: "friend_transfer", category: null });
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM line_events WHERE event = 'payee_rule' AND actor = 'owner'").get()).toEqual({ n: 4 });
		// A later word on the payee's category keeps the kind he gave it.
		await setPayeeRule(e, "BO LIM", { category: "Gift" });
		expect((await payeeRules(testEngine(db))).find((x) => x.merchant_key === "BO LIM")).toMatchObject({ kind: "friend_transfer", category: "Gift" });
	});

	it("one line by hand: only that line; a rule older than his word never moves it back", async () => {
		addRule("ACME BROKER CLIENTS", "investment", null, "2026-01-01T00:00:00.000Z");
		await put(db, "lines", line({ id: "m1", account_id: BANK.id, kind: "investment", merchant_key: "ACME BROKER CLIENTS", bill_minor: 1_000 }));
		await put(db, "lines", line({ id: "m2", account_id: BANK.id, kind: "purchase", merchant_key: "ACME BROKER CLIENTS", bill_minor: 1_000 }));
		await setLineKind(testEngine(db), "m1", "purchase");
		expect(row("m1").kind).toBe("purchase");
		const r1 = await lookBackRules(testEngine(db), null, 100);
		expect(r1).toEqual({ next: null, changed: 1 });
		expect(row("m1").kind).toBe("purchase"); // his word on this line
		expect(row("m2").kind).toBe("investment"); // the rule
		await expect(setLineKind(testEngine(db), "m1", "investment")).resolves.toMatchObject({ kind: "investment" });
		await put(db, "lines", line({ id: "f", account_id: BANK.id, kind: "fee", merchant_key: "BANK FEE", bill_minor: 100 }));
		await expect(setLineKind(testEngine(db), "f", "investment")).rejects.toThrow(/cannot be marked/);
	});

	it("the look back: categories from his rules, except a line he categorised himself; idempotent", async () => {
		addRule("JANE ROE", "purchase", "Rent");
		addRule("ACME BROKER CLIENTS", "investment");
		await put(db, "lines", line({ id: "r1", account_id: BANK.id, kind: "purchase", merchant_key: "JANE ROE", category: "Others" }));
		await put(db, "lines", line({ id: "r2", account_id: BANK.id, kind: "purchase", merchant_key: "JAXX RXX", category: null }));
		await put(db, "lines", line({ id: "r3", account_id: BANK.id, kind: "purchase", merchant_key: "JANE ROE", category: "Gift" }));
		db.raw.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) VALUES ('r3', '2026-02-01T00:00:00.000Z', 'owner', 'category', NULL, '{\"category\":\"Gift\"}')").run();
		await put(db, "lines", line({ id: "b1", account_id: BANK.id, kind: "purchase", merchant_key: "ACME BROKER CLIENTS" }));
		let cursor: string | null = null;
		let changed = 0;
		do {
			const page = await lookBackRules(testEngine(db), cursor, 2);
			cursor = page.next;
			changed += page.changed;
		} while (cursor);
		expect(changed).toBe(3);
		expect(row("r1").category).toBe("Rent");
		expect(row("r2").category).toBe("Rent");
		expect(row("r3").category).toBe("Gift");
		expect(row("b1").kind).toBe("investment");
		expect(await lookBackRules(testEngine(db), null, 100)).toEqual({ next: null, changed: 0 });
	});

	it("the month's money that is not spending, by kind (money out only)", async () => {
		await put(db, "lines", line({ id: "i1", account_id: BANK.id, kind: "investment", txn_date: "2026-03-02", bill_minor: 150_000, orig_minor: 150_000, home_minor: 150_000 }));
		await put(db, "lines", line({ id: "i2", account_id: BANK.id, kind: "investment", txn_date: "2026-03-20", bill_minor: -20_000, orig_minor: -20_000, home_minor: -20_000 }));
		await put(db, "lines", line({ id: "l1", account_id: BANK.id, kind: "loan_repayment", txn_date: "2026-03-26", bill_minor: 85_783, orig_minor: 85_783, home_minor: 85_783 }));
		await put(db, "lines", line({ id: "p1", account_id: BANK.id, kind: "purchase", txn_date: "2026-03-05", bill_minor: 1_000, orig_minor: 1_000, home_minor: 1_000 }));
		const o = await overview(db, "2026-03", "2026-03-31");
		expect(o.totals.spending_home.minor).toBe(1_000);
		expect(o.non_spending.map((n) => [n.kind, n.total_home.minor, n.count])).toEqual([
			["investment", 150_000, 1],
			["loan_repayment", 85_783, 1],
			["friend_transfer", 0, 0],
			["transfer", 0, 0],
			["card_payment", 0, 0],
		]);
	});
});

// Round 2 part C: a payee rule is about money moved by TRANSFER (PayNow, FAST,
// a bank transfer) — never a card purchase. A shop whose name starts like a
// friend's ("BELLA BOUTIQUE" against the rule "BELLA") stays spending.
describe("payee rules cover transfer lines only", () => {
	const rules = [r("BELLA", "friend_transfer"), { ...r("ACME GYM", "investment"), card_lines: 1 as const }];

	it("which lines are transfers", () => {
		expect(isTransferLine("bank", "PAYNOW TRANSFER BELLA MOBILE ENDING 1234", "transfer")).toBe(true);
		expect(isTransferLine("bank", "BELLA TAN", null)).toBe(true); // a bank account line: a transfer…
		expect(isTransferLine("bank", "NETS BELLA BOUTIQUE", "purchase")).toBe(false); // …unless it reads as a card payment
		expect(isTransferLine("debit_card", "PAYNOW TO BELLA", "purchase")).toBe(true); // a wallet's PayNow
		expect(isTransferLine("debit_card", "BELLA BOUTIQUE", "purchase")).toBe(false);
		expect(isTransferLine("credit_card", "PAYNOW BELLA", "transfer")).toBe(false); // a credit card line never is
		expect(isTransferLine("cash", "BELLA", null)).toBe(false);
		expect(isTransferLine(undefined, "BELLA", null)).toBe(false); // a receipt
	});

	it("a card line only by a rule the owner made from a card line, by exactly its name", () => {
		expect(ruleForLine("BELLA MOBILE ENDING", true, rules)?.merchant_key).toBe("BELLA");
		expect(ruleForLine("BELLA BOUTIQUE", false, rules)).toBeNull();
		expect(ruleForLine("BELLA", false, rules)).toBeNull(); // a transfer-only rule, even by exactly the name
		expect(ruleForLine("ACME GYM", false, rules)?.merchant_key).toBe("ACME GYM");
		expect(ruleForLine("ACME GYM CLUB", false, rules)).toBeNull(); // never by prefix on a card
	});

	describe("in the ledger", () => {
		let db: TestDb;
		beforeEach(async () => {
			db = freshDb();
			await addAccounts(db);
			db.raw.prepare("DELETE FROM payee_rules").run();
			db.raw.prepare("INSERT INTO payee_rules (merchant_key, kind, category, set_by, updated_at) VALUES ('BELLA', 'friend_transfer', NULL, 'owner', '2026-10-01T00:00:00.000Z')").run();
		});
		afterEach(() => db.close());
		const kind = (id: string) => (db.raw.prepare("SELECT kind FROM lines WHERE id = ?").get(id) as { kind: string }).kind;

		it("a new card alert from a shop named like a friend stays spending; the friend's PayNow does not", async () => {
			const e = testEngine(db);
			const shop = await ingestEvidence(e, { type: "alert", institution: "hsbc", last4: CARD_A.last4, fingerprint: "c1", txn_date: "2026-03-10", currency: "SGD", amount_minor: 4_500, merchant_raw: "BELLA BOUTIQUE", kind_hint: "purchase" });
			expect(kind((shop as { line_id: string }).line_id)).toBe("purchase");
			const debit = await ingestEvidence(e, { type: "alert", institution: "dbs", last4: DEBIT.last4, fingerprint: "c2", txn_date: "2026-03-10", currency: "SGD", amount_minor: 1_200, merchant_raw: "BELLA CAFE", kind_hint: "purchase" });
			expect(kind((debit as { line_id: string }).line_id)).toBe("purchase");
			const friend = await ingestEvidence(e, { type: "alert", institution: "dbs", last4: BANK.last4, fingerprint: "c3", txn_date: "2026-03-11", currency: "SGD", amount_minor: 30_000, merchant_raw: "BELLA MOBILE ENDING 1234", kind_hint: "transfer" });
			expect(kind((friend as { line_id: string }).line_id)).toBe("friend_transfer");
		});

		it("the look back and the owner's rule leave card purchases alone", async () => {
			await put(db, "lines", line({ id: "shop", account_id: CARD_A.id, kind: "purchase", merchant_raw: "BELLA BOUTIQUE", merchant_key: "BELLA BOUTIQUE", bill_minor: 4_500 }));
			await put(db, "lines", line({ id: "pn", account_id: BANK.id, kind: "transfer", merchant_raw: "PAYNOW BELLA MOBILE", merchant_key: "BELLA MOBILE", bill_minor: 30_000 }));
			expect((await lookBackRules(testEngine(db), null, 100)).changed).toBe(1);
			expect(kind("shop")).toBe("purchase");
			expect(kind("pn")).toBe("friend_transfer");
			const again = await setPayeeRule(testEngine(db, "owner"), "BELLA", { kind: "loan_repayment" });
			expect(again.changed).toBe(1);
			expect(kind("shop")).toBe("purchase");
		});

		it("a rule the owner makes from a card line covers that merchant's card lines by exactly its name", async () => {
			await put(db, "lines", line({ id: "g1", account_id: CARD_A.id, kind: "purchase", merchant_raw: "ACME GYM", merchant_key: "ACME GYM", bill_minor: 9_900 }));
			await put(db, "lines", line({ id: "g2", account_id: CARD_A.id, kind: "purchase", merchant_raw: "ACME GYM CLUB", merchant_key: "ACME GYM CLUB", bill_minor: 9_900 }));
			const out = await setPayeeRule(testEngine(db, "owner"), "ACME GYM", { kind: "investment" }, { cardLines: true });
			expect(out.changed).toBe(1);
			expect(kind("g1")).toBe("investment");
			expect(kind("g2")).toBe("purchase");
			const next = await ingestEvidence(testEngine(db), { type: "alert", institution: "hsbc", last4: CARD_A.last4, fingerprint: "g3", txn_date: "2026-04-10", currency: "SGD", amount_minor: 9_900, merchant_raw: "ACME GYM", kind_hint: "purchase" });
			expect(kind((next as { line_id: string }).line_id)).toBe("investment");
		});
	});
});
