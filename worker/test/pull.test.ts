/// Listing Gmail. Made-up mail only.

import { EXAMPLE_BANKS as BANKS } from "./helpers/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { emptyPlaybook } from "../../src/playbook";
import { GmailError } from "../src/gmail";
import { dailyPull, gmailQuery, senderDomains } from "../src/pull";
import { runTick } from "../src/tick";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { exactCountingDb, makeDeps, makeEnv } from "./helpers/harness";

let db: TestDb;
beforeEach(() => {
	db = freshDb();
	db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'daily', 'x'), ('backfill', ?, 'x')").run(JSON.stringify({ done: true, started_at: "2026-10-01T00:00:00.000Z" }));
});
afterEach(() => db.close());

const work = () => db.raw.prepare("SELECT gmail_id, source, stage FROM work ORDER BY gmail_id").all() as { gmail_id: string; source: string; stage: string }[];

function inbox(n: number, at = "2026-10-08T02:00:00.000Z"): FakeGmail {
	const g = new FakeGmail();
	for (let i = 0; i < n; i++) g.add(mail({ id: `m${String(i).padStart(3, "0")}`, received_at: new Date(new Date(at).getTime() - i * 60_000).toISOString() }));
	return g;
}

describe("the Gmail search", () => {
	it("asks for bank senders, purchases and receipt subjects, never the ledger's own summary", () => {
		const q = gmailQuery(["dbs.com", "hsbc.com.sg"], BANKS.searchNames(), "Ledger <ledger@example.com>", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z"));
		expect(q).toBe(`(from:(dbs.com OR hsbc.com.sg OR ibanking OR digibank OR paylah OR posb OR hsbc OR richart) OR category:purchases OR subject:(receipt OR invoice OR "order confirmation" OR "booking confirmation" OR e-ticket OR itinerary OR 收據 OR 發票) OR (from:grab.com subject:(receipt OR statement OR "top up" OR "top-up" OR transaction OR GrabPay))) -from:ledger@example.com after:${Date.UTC(2026, 9, 1) / 1000} before:${Date.UTC(2026, 9, 2) / 1000}`);
	});

	it("searches the banks plus every sender the playbook learned; the var replaces the learned ones, never the banks", () => {
		const book = emptyPlaybook();
		book.senders.alerts.push({ institution: "dbs", from: "ibanking.alert@dbs.com" });
		book.senders.receipts.push("@shop.example");
		const banks = ["dbs.com", "dbs.com.sg", "posb.com.sg", "hsbc.com.sg", "hsbc.com", "hsbc.com.hk", "citibank.com.sg", "citibank.com", "citi.com", "taishinbank.com.tw" /* every domain on the owner's bank list (the example seed's) */];
		expect(senderDomains(undefined, book, BANKS)).toEqual([...banks, "shop.example"]);
		expect(senderDomains(" a.example, @b.example ", book, BANKS)).toEqual([...banks, "a.example", "b.example"]);
	});
});

describe("the daily pull", () => {
	it("queues every listed message not yet read, page by page, once a day from 06:00 Singapore", async () => {
		const g = inbox(250);
		g.pageSize = 100;
		db.raw.prepare("INSERT INTO messages (gmail_id, received_at, classification, processed_at) VALUES ('m001', 'x', 'alert', 'x')").run();
		const deps = makeDeps("2026-10-08T23:00:00.000Z"); // 07:00 on the 9th in Singapore
		const r = await runTick(makeEnv(db), deps, { gmail: g }, [dailyPull]);
		expect(r.counts).toMatchObject({ listed: 250, list_pages: 3 });
		expect(work()).toHaveLength(249); // m001 was already read
		expect(work().every((w) => w.source === "daily" && w.stage === "new")).toBe(true);
		expect(g.queries[0]).toContain(`after:${Math.floor(new Date("2026-09-29T00:00:00Z").getTime() / 1000)}`); // backfill start − 2 days
		// the same day: nothing more
		deps.advance(3_600_000);
		expect((await runTick(makeEnv(db), deps, { gmail: g }, [dailyPull])).counts).toEqual({});
		// the next day: reaches back two days before the last pull started
		deps.advance(24 * 3_600_000);
		await runTick(makeEnv(db), deps, { gmail: g }, [dailyPull]);
		expect(g.queries.at(-1)).toContain(`after:${Math.floor(new Date("2026-10-06T23:00:00Z").getTime() / 1000)}`);
		expect(work()).toHaveLength(249); // the overlap re-lists, never re-queues
	});

	it("waits for 06:00, and for the backfill to list the current month (not for it to finish)", async () => {
		const g = inbox(5);
		await runTick(makeEnv(db), makeDeps("2026-10-08T21:00:00.000Z"), { gmail: g }, [dailyPull]); // 05:00
		expect(g.calls.list).toBe(0);
		const backfill = (listing: object | null, i = 0) =>
			db.raw.prepare("UPDATE sync_state SET value = ? WHERE key = 'backfill'").run(JSON.stringify({ months: ["2026-10", "2026-09"], i, listing, started_at: "2026-10-01T00:00:00.000Z", done: false }));
		db.raw.prepare("UPDATE sync_state SET value = 'backfill' WHERE key = 'phase'").run();
		backfill({ q: "x", page: "p2", done: false, listed: 100 }); // still listing this month
		await runTick(makeEnv(db), makeDeps(), { gmail: g }, [dailyPull]);
		expect(g.calls.list).toBe(0);
		backfill(null, 1); // this month listed; the backfill is on to older months
		await runTick(makeEnv(db), makeDeps(), { gmail: g }, [dailyPull]);
		expect(g.calls.list).toBe(1);
		expect(work()).toHaveLength(5);
		expect(work().every((w) => w.source === "daily")).toBe(true);
	});

	it("a tight budget stops between pages and the next tick carries on from the saved page", async () => {
		const g = inbox(500);
		g.pageSize = 10;
		const deps = makeDeps();
		const c = exactCountingDb(db);
		const env = makeEnv(c.db, { LEDGER_TICK_D1_BUDGET: "40" });
		let ticks = 0;
		while (work().length < 500 && ticks < 20) {
			c.reset();
			await runTick(env, deps, { gmail: g }, [dailyPull]);
			expect(c.queries()).toBeLessThanOrEqual(40);
			ticks++;
		}
		expect(work()).toHaveLength(500);
		expect(ticks).toBeGreaterThan(1);
		expect(g.calls.list).toBe(50); // no page listed twice
	});

	it("Google refusing the sign-in raises the alarm the owner sees; the next good answer clears it", async () => {
		const g = inbox(3);
		g.fail = new GmailError("signin_failed", "invalid_grant");
		const deps = makeDeps();
		await runTick(makeEnv(db), deps, { gmail: g }, [dailyPull]);
		expect(db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL").all()).toEqual([{ key: "google_signin" }]);
		g.fail = null;
		await runTick(makeEnv(db), deps, { gmail: g }, [dailyPull]);
		expect(db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL").all()).toEqual([]);
		expect(work()).toHaveLength(3);
	});
});

// Gmail reads `a OR b c` as `(a OR b) AND c`. A clause with two words side by
// side (Grab's from + subject) must sit in its own brackets, or every bank's
// mail must also match Grab's subject words — DBS's "iBanking Alerts" do not,
// and none reached the ledger from 14 to 18 Oct 2026 .
describe("the Gmail search keeps every clause apart", () => {
	it("no bare two-word clause at the top level of the OR group", () => {
		const q = gmailQuery(["dbs.com"], BANKS.searchNames(), "ledger@example.com", new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 2)));
		const group = q.slice(1, q.lastIndexOf(") -from:"));
		// Split the top-level group on " OR " outside brackets and quotes.
		const parts: string[] = [];
		let depth = 0;
		let quoted = false;
		let cur = "";
		for (let i = 0; i < group.length; i++) {
			const ch = group[i]!;
			if (ch === '"') quoted = !quoted;
			if (!quoted && ch === "(") depth++;
			if (!quoted && ch === ")") depth--;
			if (!quoted && depth === 0 && group.startsWith(" OR ", i)) {
				parts.push(cur);
				cur = "";
				i += 3;
				continue;
			}
			cur += ch;
		}
		parts.push(cur);
		expect(parts.length).toBeGreaterThanOrEqual(4);
		for (const p of parts) {
			// Each top-level part is one term: no space outside its own brackets/quotes.
			let d = 0;
			let qd = false;
			for (const ch of p.trim()) {
				if (ch === '"') qd = !qd;
				if (!qd && ch === "(") d++;
				if (!qd && ch === ")") d--;
				expect(!qd && d === 0 && ch === " ").toBe(false);
			}
		}
	});
});
