/// The look back (round 2, ask 7): old lines re-read under the new rules, a
/// page at a time within the tick's D1 budget, once per LOOK_BACK_VERSION.
/// MADE-UP accounts and amounts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { line } from "../../test/helpers/fixtures";
import { addAccounts, put } from "../../test/helpers/world";
import { runTick } from "../src/tick";
import { CARD_COUNTERS_VERSION, cardCounters, LOOK_BACK_PAGE, LOOK_BACK_VERSION, lookBack, type LookBackState } from "../src/upkeep";
import { MODELS } from "./helpers/fake-claude";
import { makeDeps, makeEnv } from "./helpers/harness";

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
});
afterEach(() => db.close());

const state = () => {
	const row = db.raw.prepare("SELECT value FROM sync_state WHERE key = 'look_back'").get() as { value: string } | undefined;
	return row ? (JSON.parse(row.value) as LookBackState) : null;
};

describe("the look back", () => {
	it("turns every old bank payment to a card issuer into a card payment, across ticks, then stops", async () => {
		const n = LOOK_BACK_PAGE * 3 + 2;
		for (let i = 0; i < n; i++) {
			await put(db, "lines", line({ id: `b${String(i).padStart(3, "0")}`, account_id: "bank-x", kind: "purchase", state: "posted", merchant_raw: "BILL PAYMENT CITIBANK", bill_minor: 1000 + i, orig_minor: 1000 + i, home_minor: 1000 + i, txn_date: "2026-01-15" }));
		}
		// A tight budget: one page a tick.
		const env = { ...makeEnv(db, MODELS), LEDGER_TICK_D1_BUDGET: "60" };
		const deps = makeDeps("2026-10-09T05:00:00.000Z");
		let ticks = 0;
		while (state()?.piece !== "done" && ticks < 20) {
			await runTick(env, deps, {}, [lookBack]);
			deps.advance(60_000);
			ticks++;
		}
		expect(ticks).toBeGreaterThan(1);
		expect(state()).toMatchObject({ version: LOOK_BACK_VERSION, piece: "done", changed: n });
		expect(db.raw.prepare("SELECT DISTINCT kind, counter_account_id FROM lines").all()).toEqual([{ kind: "card_payment", counter_account_id: "card-c" }]);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM line_events WHERE event = 'reclassify_card_payment'").get()).toEqual({ n });

		// Done is done: a later tick reads nothing.
		deps.advance(86_400_000);
		const r = await runTick(env, deps, {}, [lookBack]);
		expect(r.counts.look_back_changed ?? 0).toBe(0);
	});

	it("a ledger that finished v3 undoes the old amount-only matches, pairs again and never re-reads statements", async () => {
		const L = (over: Parameters<typeof line>[0]) => put(db, "lines", line(over));
		await L({ id: "citi-paid", account_id: "card-c", kind: "card_payment", txn_date: "2026-06-25", orig_minor: -25_000, bill_minor: -25_000, home_minor: -25_000, transfer_group: "g-old", counter_account_id: "bank-x" });
		await L({ id: "tan", account_id: "bank-x", kind: "card_payment", txn_date: "2026-06-25", merchant_raw: "TAN AH-KXXX", orig_minor: 25_000, bill_minor: 25_000, home_minor: 25_000, transfer_group: "g-old", counter_account_id: "card-c" });
		await L({ id: "plain", account_id: "bank-x", kind: "purchase", txn_date: "2026-06-25", merchant_raw: null, orig_minor: 25_000, bill_minor: 25_000, home_minor: 25_000 });
		const ev = db.raw.prepare("INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) VALUES (?, '2026-10-01T00:00:00.000Z', 'rules', ?, ?, ?)");
		ev.run("tan", "card_payment_by_amount", '{"kind":"purchase","counter_account_id":null}', '{"kind":"card_payment","counter_account_id":"card-c"}');
		ev.run("citi-paid", "pair_transfer", '{"transfer_group":null,"counter_account_id":null}', '{"transfer_group":"g-old","counter_account_id":"bank-x"}');
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('look_back', ?, '2026-10-01T00:00:00.000Z')").run(JSON.stringify({ version: 3, piece: "done", cursor: null, changed: 4 }));
		const env = makeEnv(db, MODELS);
		const deps = makeDeps("2026-10-12T05:00:00.000Z");
		const r = await runTick(env, deps, {}, [lookBack]);
		expect(r.counts.look_back_undone).toBe(1);
		expect(r.counts.look_back_reread_queued ?? 0).toBe(0);
		expect(state()).toMatchObject({ version: LOOK_BACK_VERSION, piece: "done", changed: 5 });
		const rows = db.raw.prepare("SELECT id, kind, transfer_group FROM lines ORDER BY id").all() as { id: string; kind: string; transfer_group: string | null }[];
		const by = Object.fromEntries(rows.map((x) => [x.id, x]));
		expect(by["tan"]).toMatchObject({ kind: "purchase", transfer_group: null });
		expect(by["plain"]!.kind).toBe("card_payment");
		expect(by["plain"]!.transfer_group).toBe(by["citi-paid"]!.transfer_group);
		expect(by["plain"]!.transfer_group).not.toBeNull();
	});
});

describe("card counters (one-time, 14 Oct 2026)", () => {
	it("fills the card on an old DBS card bill once, then never runs again", async () => {
		await put(db, "lines", line({ id: "paid-a", account_id: "bank-x", kind: "card_payment", merchant_raw: "Other bank's card ending 1111", bill_minor: 16_294, orig_minor: 16_294, home_minor: 16_294, txn_date: "2026-09-26" }));
		const env = makeEnv(db, MODELS);
		const deps = makeDeps("2026-10-14T05:00:00.000Z");
		const r = await runTick(env, deps, {}, [cardCounters]);
		expect(r.counts.card_counters_filled).toBe(1);
		expect(db.raw.prepare("SELECT counter_account_id FROM lines WHERE id = 'paid-a'").get()).toEqual({ counter_account_id: "card-a" });
		expect(JSON.parse((db.raw.prepare("SELECT value FROM sync_state WHERE key = 'card_counters'").get() as { value: string }).value)).toBe(CARD_COUNTERS_VERSION);
		// Done is done: a line left without its card later is not this step's (the rules fill it as it is filed).
		db.raw.prepare("UPDATE lines SET counter_account_id = NULL WHERE id = 'paid-a'").run();
		deps.advance(60_000);
		const again = await runTick(env, deps, {}, [cardCounters]);
		expect(again.counts.card_counters_filled ?? 0).toBe(0);
	});
});
