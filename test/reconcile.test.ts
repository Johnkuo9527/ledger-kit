/// Reconciliation per account kind. Every total below was added up by hand.

import { describe, expect, it } from "vitest";
import { IllegalTransition, transition } from "../src/lifecycle";
import { isMissedByAlerts, isNotOnStatement, reconcileStatement, reconStatusFor, statementAccountId } from "../src/reconcile";
import { BANK, CARD_A, CASH, DEBIT, evidence, line, statement } from "./helpers/fixtures";

describe("a credit card: the month's lines equal the statement total to the cent", () => {
	// Opening (owed) SGD 1,200.00, closing SGD 987.65 → net −212.35 = −21235.
	// Lines: payment −1,200.00 + 450.00 + 300.00 (a USD charge) + 250.00 − 12.35 refund
	//      = −120000 + 45000 + 30000 + 25000 − 1235 = −21235. ✓
	const S = statement({ id: "S1", account_id: CARD_A.id, opening_balance_minor: 120000, closing_balance_minor: 98765 });
	const build = () => {
		const lines = [
			line({ id: "pay", kind: "card_payment", bill_minor: -120000, orig_minor: -120000, statement_id: "S1", state: "posted" }),
			line({ id: "p1", bill_minor: 45000, orig_minor: 45000, statement_id: "S1", state: "posted" }),
			line({ id: "usd", orig_currency: "USD", orig_minor: 22000, bill_minor: 30000, bill_status: "confirmed", statement_id: "S1", state: "posted" }),
			line({ id: "p2", bill_minor: 25000, orig_minor: 25000, statement_id: "S1", state: "posted" }),
			line({ id: "rf", kind: "refund", bill_minor: -1235, orig_minor: -1235, statement_id: "S1", state: "posted" }),
		];
		const printed = [
			evidence({ line_id: "pay", statement_id: "S1", amount_minor: -120000 }),
			evidence({ line_id: "p1", statement_id: "S1", amount_minor: 45000 }),
			evidence({ line_id: "usd", statement_id: "S1", currency: "USD", amount_minor: 22000, bill_currency: "SGD", bill_minor: 30000 }),
			evidence({ line_id: "p2", statement_id: "S1", amount_minor: 25000 }),
			evidence({ line_id: "rf", statement_id: "S1", amount_minor: -1235 }),
		];
		return { lines, printed };
	};

	it("passes when everything adds up", () => {
		const { lines, printed } = build();
		const r = reconcileStatement(S, "credit_card", lines, printed);
		expect(r).toMatchObject({ ok: true, rule: "card_total", expected_minor: -21235, ledger_minor: -21235, statement_lines_minor: -21235, difference_minor: 0, line_count: 5 });
		expect(reconStatusFor(r)).toBe("reconciled");
	});

	it("uses the printed total when there is one, and checks it against the balances", () => {
		const { lines, printed } = build();
		expect(reconcileStatement({ ...S, printed_net_minor: -21235 }, "credit_card", lines, printed).ok).toBe(true);
		const r = reconcileStatement({ ...S, printed_net_minor: -21000 }, "credit_card", lines, printed);
		expect(r.ok).toBe(false);
		expect(r.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["printed_total_disagrees", "statement_lines_mismatch", "ledger_mismatch"]));
	});

	it("fails on a single cent, and says by how much", () => {
		const { lines, printed } = build();
		lines[1]!.bill_minor = 45001;
		const r = reconcileStatement(S, "credit_card", lines, printed);
		expect(r).toMatchObject({ ok: false, difference_minor: 1 });
		expect(r.problems.map((p) => p.code)).toEqual(["ledger_mismatch"]);
		expect(reconStatusFor(r)).toBe("escalated");
	});

	it("ignores a void line, and fails if that leaves the ledger short", () => {
		const { lines, printed } = build();
		lines[3]!.state = "void";
		expect(reconcileStatement(S, "credit_card", lines, printed)).toMatchObject({ ok: false, ledger_minor: -46235 });
	});

	it("fails on a statement line with no ledger line, a line under review, an estimate, a stray currency", () => {
		const { lines, printed } = build();
		printed[1]!.line_id = null;
		lines[2]!.state = "review";
		lines[3]!.bill_status = "estimate";
		lines[4]!.bill_currency = "USD";
		const codes = reconcileStatement(S, "credit_card", lines, printed).problems.map((p) => p.code);
		expect(codes).toEqual(expect.arrayContaining(["unmatched_statement_line", "line_in_review", "estimate_on_statement", "currency_mismatch"]));
	});

	it("cannot reconcile with no total and no balances", () => {
		const { lines, printed } = build();
		const r = reconcileStatement({ ...S, opening_balance_minor: null }, "credit_card", lines, printed);
		expect(r.problems.map((p) => p.code)).toContain("no_total");
		expect(r.ok).toBe(false);
	});
});

describe("a bank account: opening + movements = closing", () => {
	// Opening SGD 5,000.00, closing SGD 4,315.00 → money out 685.00 = 68500.
	// Lines (+ out): debit-card purchase 120.00 + card bill 500.00 − PayNow in 80.00 + transfer 145.00
	//              = 12000 + 50000 − 8000 + 14500 = 68500. ✓
	const S = statement({ id: "B1", account_id: BANK.id, opening_balance_minor: 500000, closing_balance_minor: 431500 });
	const lines = [
		line({ id: "dc", account_id: DEBIT.id, bill_minor: 12000, orig_minor: 12000, statement_id: "B1", state: "posted" }),
		line({ id: "cp", account_id: BANK.id, kind: "card_payment", bill_minor: 50000, orig_minor: 50000, statement_id: "B1", state: "posted" }),
		line({ id: "in", account_id: BANK.id, kind: "income", bill_minor: -8000, orig_minor: -8000, statement_id: "B1", state: "posted" }),
		line({ id: "tr", account_id: BANK.id, kind: "transfer", bill_minor: 14500, orig_minor: 14500, statement_id: "B1", state: "posted" }),
	];
	const printed = lines.map((l) => evidence({ line_id: l.id, statement_id: "B1", amount_minor: l.bill_minor }));

	it("passes, counting the debit card's spending on the bank's statement", () => {
		expect(reconcileStatement(S, "bank", lines, printed)).toMatchObject({ ok: true, rule: "bank_balance", expected_minor: 68500, ledger_minor: 68500 });
	});

	it("needs both balances", () => {
		const r = reconcileStatement({ ...S, closing_balance_minor: null }, "bank", lines, printed);
		expect(r.problems.map((p) => p.code)).toContain("no_balances");
	});

	it("checks a printed net against the balances", () => {
		expect(reconcileStatement({ ...S, printed_net_minor: 68500 }, "bank", lines, printed).ok).toBe(true);
		expect(reconcileStatement({ ...S, printed_net_minor: 68400 }, "bank", lines, printed).problems.map((p) => p.code)).toContain("printed_total_disagrees");
	});

	it("refuses to reconcile a debit card or cash on their own", () => {
		expect(reconcileStatement(S, "debit_card", lines, printed).problems.map((p) => p.code)).toEqual(["not_reconcilable"]);
	});
});

describe("flags from a statement", () => {
	it("knows which statement carries each account's lines", () => {
		expect(statementAccountId(CARD_A)).toBe(CARD_A.id);
		expect(statementAccountId(DEBIT)).toBe(BANK.id);
		expect(statementAccountId(CASH)).toBeNull();
	});

	it("flags an alert-only line once a statement closing 5+ days after it has come", () => {
		const l = line({ txn_date: "2026-03-10" });
		expect(isNotOnStatement(l, [{ period_end: "2026-03-14" }])).toBe(false); // may post on the next one
		expect(isNotOnStatement(l, [{ period_end: "2026-03-15" }])).toBe(true);
		expect(isNotOnStatement({ ...l, statement_id: "S1" }, [{ period_end: "2026-04-15" }])).toBe(false);
		expect(isNotOnStatement({ ...l, state: "void" }, [{ period_end: "2026-04-15" }])).toBe(false);
		expect(isNotOnStatement(l, [])).toBe(false);
	});

	it("a line from before the first statement the ledger has is not flagged by a later one (Citi bills the owner uploads)", () => {
		const l = line({ txn_date: "2026-03-10" });
		expect(isNotOnStatement(l, [{ period_start: "2026-08-16", period_end: "2026-09-15" }])).toBe(false);
		expect(isNotOnStatement(l, [{ period_start: "2026-02-16", period_end: "2026-03-15" }])).toBe(true);
		expect(isNotOnStatement(l, [{ period_start: "2026-03-15", period_end: "2026-04-15" }])).toBe(true); // posts by the 15th
		expect(isNotOnStatement(l, [{ period_start: "2026-03-16", period_end: "2026-04-15" }])).toBe(false);
	});

	it("flags a statement line no alert told us about", () => {
		expect(isMissedByAlerts(CARD_A, new Set(["statement_line"]))).toBe(true);
		expect(isMissedByAlerts(CARD_A, new Set(["statement_line", "alert"]))).toBe(false);
		expect(isMissedByAlerts(CARD_A, new Set(["statement_line", "receipt"]))).toBe(true);
		expect(isMissedByAlerts(CASH, new Set(["statement_line"]))).toBe(false);
	});
});

describe("a line's life", () => {
	it("moves open → posted → reconciled, and back when a month breaks", () => {
		expect(transition("open", "attach_statement", true)).toBe("posted");
		expect(transition("posted", "reconcile", true)).toBe("reconciled");
		expect(transition("reconciled", "unreconcile", true)).toBe("posted");
	});

	it("goes to review from anywhere live, and resolves to where it belongs", () => {
		expect(transition("reconciled", "flag_review", true)).toBe("review");
		expect(transition("review", "resolve", true)).toBe("posted");
		expect(transition("review", "resolve", false)).toBe("open");
		expect(transition("review", "attach_statement", true)).toBe("review");
	});

	it("voids and restores", () => {
		expect(transition("posted", "void", true)).toBe("void");
		expect(transition("void", "restore", false)).toBe("open");
	});

	it("refuses an illegal jump", () => {
		expect(() => transition("void", "reconcile", true)).toThrow(IllegalTransition);
		expect(() => transition("open", "reconcile", false)).toThrow(IllegalTransition);
		expect(() => transition("posted", "attach_statement", true)).toThrow(IllegalTransition);
		expect(() => transition("void", "void", false)).toThrow(IllegalTransition);
		expect(() => transition("open", "resolve", false)).toThrow(IllegalTransition);
	});
});
