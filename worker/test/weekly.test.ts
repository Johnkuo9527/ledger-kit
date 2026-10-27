/// The owner's email: the weekly summary, the urgent alarms, credit low
///. Made-up ledger, Resend mocked.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { line } from "../../test/helpers/fixtures";
import { put } from "../../test/helpers/world";
import { SUMMARY_MARKER } from "../../src/dedup";
import { runTick } from "../src/tick";
import { creditCheck, mondayOf, urgentMail, weekly } from "../src/weekly";
import { makeDeps, makeEnv, seedWorld } from "./helpers/harness";

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await seedWorld(db);
	db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'daily', 'x')").run();
});
afterEach(() => db.close());

const MONDAY_9AM = "2026-10-12T01:00:00.000Z";

describe("the weekly email", () => {
	it("Monday from 08:00: headline, bullets, NEEDS YOU, subscriptions, trips; sent once", async () => {
		await put(db, "lines", line({ id: "w1", account_id: "card-a", txn_date: "2026-10-07", merchant_name: "Big Shop", orig_minor: 25000, bill_minor: 25000, home_minor: 25000 }));
		await put(db, "lines", line({ id: "w2", account_id: "card-t", txn_date: "2026-10-08", merchant_name: "Night Market", orig_currency: "TWD", orig_minor: 100000, bill_currency: "TWD", bill_minor: 100000, home_minor: 4200, home_status: "reference", home_rate: 0.042 }));
		db.raw.prepare("INSERT INTO subscriptions (id, merchant_key, merchant_name, currency, cadence, amount_minor, first_seen, last_charged, next_renewal, occurrences, status, line_ids_json, updated_at, detected_at) VALUES ('s-new', 'MUSICCO', 'Musicco', 'SGD', 'monthly', 1099, '2026-08-01', '2026-10-01', '2026-11-01', 3, 'active', '[]', 'x', '2026-10-10T00:00:00.000Z')").run();
		const deps = makeDeps(MONDAY_9AM);
		const env = makeEnv(db);
		await runTick(env, deps, {}, [weekly]);
		expect(deps.mail.sent).toHaveLength(1);
		const m = deps.mail.sent[0] as unknown as { subject: string; text: string; headers: Record<string, string>; to: string[] };
		expect(m.to).toEqual(["owner@example.com"]);
		expect(m.headers).toEqual({ "X-Ledger-Summary": "1" });
		const lines = m.text.split("\n");
		expect(lines[0]).toMatch(/^Last week \(2026-10-05 to 2026-10-11\) you spent SGD [\d,]+\.\d\d, of which SGD 84\.00 is still an estimate until the statement comes\.$/);
		expect(m.text).toContain("Largest: Big Shop SGD 250.00");
		expect(m.text).toContain("NEEDS YOU");
		expect(m.text).toContain("A trip to Testville, JP, 2026-09-10 to 2026-09-14: confirm or dismiss it.");
		expect(m.text).toContain("Apple Pay tap(s)");
		expect(m.text).toContain("does not add up");
		expect(m.text).toContain("NEW SUBSCRIPTIONS\n- Musicco: SGD 10.99 monthly");
		expect(m.text).toContain("TRIPS PROPOSED");
		expect(m.text.endsWith(SUMMARY_MARKER)).toBe(true);
		// the lock screen shows the subject: no money in it, only in the body
		expect(m.subject).toMatch(/^Ledger: your week, 2026-10-05 to 2026-10-11 — \d+ thing\(s\) need you$/);
		expect(m.subject).not.toMatch(/SGD|\d+\.\d\d/);
		deps.advance(60_000);
		await runTick(env, deps, {}, [weekly]);
		expect(deps.mail.sent).toHaveLength(1);
	});

	it("not before 08:00 Monday, and a quiet week says Nothing", async () => {
		db.raw.prepare("DELETE FROM trips").run();
		db.raw.prepare("DELETE FROM statements").run();
		db.raw.prepare("DELETE FROM evidence WHERE line_id IS NULL").run(); // the held tap
		const early = makeDeps("2026-10-11T23:00:00.000Z"); // Monday 07:00
		await runTick(makeEnv(db), early, {}, [weekly]);
		expect(early.mail.sent).toHaveLength(0);
		early.advance(3_600_000);
		await runTick(makeEnv(db), early, {}, [weekly]);
		expect(early.mail.sent[0]!.text).toContain("NEEDS YOU\nNothing.");
		expect(mondayOf("2026-10-11")).toBe("2026-10-05");
		expect(mondayOf("2026-10-12")).toBe("2026-10-12");
	});

	it("a note the model wrote after reading an untrusted email is labelled unverified", async () => {
		const notes = [
			{ escalation_id: "e1", note: "Check the refund at Kopi.", at: "2026-10-08T00:00:00.000Z" },
			{ escalation_id: "e2", note: "Your bank asks you to call.", at: "2026-10-08T00:00:00.000Z", unverified: true },
		];
		db.raw.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('notes_for_owner', ?, 'x')").run(JSON.stringify(notes));
		const deps = makeDeps(MONDAY_9AM);
		await runTick(makeEnv(db), deps, {}, [weekly]);
		const text = deps.mail.sent[0]!.text as string;
		expect(text).toContain("- Check the refund at Kopi.");
		expect(text).toMatch(/- \[Unverified[^\]]*\] Your bank asks you to call\./);
	});
});

describe("alarms by email", () => {
	it("an urgent alarm is emailed at once, and only once per raising", async () => {
		db.raw.prepare("INSERT INTO alarms (key, message, raised_at) VALUES ('google_signin', 'Google refused the sign-in.', 'x'), ('credit_low', 'low', 'x')").run();
		const deps = makeDeps();
		await runTick(makeEnv(db), deps, {}, [urgentMail]);
		expect(deps.mail.sent).toHaveLength(1);
		expect(deps.mail.sent[0]!.subject).toBe("Ledger: needs you now");
		expect(deps.mail.sent[0]!.text).toContain("Google refused the sign-in.");
		expect(deps.mail.sent[0]!.text).not.toContain("low"); // credit low waits for Monday
		deps.advance(60_000);
		await runTick(makeEnv(db), deps, {}, [urgentMail]);
		expect(deps.mail.sent).toHaveLength(1);
		expect(db.raw.prepare("SELECT notified_at FROM alarms WHERE key = 'google_signin'").get()).toEqual({ notified_at: "2026-10-09T02:00:00.000Z" });
	});

	it("credit low: the top-up minus what was spent since, under the line; cleared once topped up", async () => {
		db.raw.prepare("INSERT INTO api_spend (day, model, usd, calls) VALUES ('2026-09-30', 'claude-opus-5-5', 50, 10), ('2026-10-02', 'claude-opus-5-5', 4, 3), ('2026-10-08', 'claude-sonnet-5-5', 3, 30)").run();
		const deps = makeDeps();
		await runTick(makeEnv(db, { LEDGER_API_CREDIT_USD: "10", LEDGER_API_CREDIT_SINCE: "2026-10-01" }), deps, {}, [creditCheck]);
		expect(db.raw.prepare("SELECT key, message FROM alarms WHERE cleared_at IS NULL").all()).toEqual([{ key: "credit_low", message: expect.stringContaining("about US$3") }]);
		deps.advance(24 * 3_600_000);
		await runTick(makeEnv(db, { LEDGER_API_CREDIT_USD: "50", LEDGER_API_CREDIT_SINCE: "2026-10-01" }), deps, {}, [creditCheck]);
		expect(db.raw.prepare("SELECT key FROM alarms WHERE cleared_at IS NULL").all()).toEqual([]);
	});
});
