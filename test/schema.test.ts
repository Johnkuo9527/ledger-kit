/// The schema is the contract the page, the connector and the worker build against, so it is tested as one:
/// the code's row shapes and the tables agree column for column, and the
/// constraints that protect the money actually refuse bad rows.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../src/db";
import { publishPlaybook, readHead } from "../src/playbook-store";
import { emptyPlaybook } from "../src/playbook";
import { ACCOUNT_INSERT, accountValues } from "../src/seed";
import { CARD_A, evidence, line, statement } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";

let db: TestDb;
beforeEach(async () => {
	db = freshDb();
	await db.prepare(ACCOUNT_INSERT).bind(...accountValues(CARD_A)).run();
});
afterEach(() => db.close());

const columns = (table: string) => (db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name).sort();

describe("code and tables agree, column for column", () => {
	it.each([
		["lines", () => line()],
		["evidence", () => evidence()],
		["statements", () => statement({ id: "s", account_id: CARD_A.id })],
		["accounts", () => CARD_A],
	])("%s", (table, make) => {
		expect(Object.keys(make()).sort()).toEqual(columns(table));
	});
});

describe("the money constraints bite", () => {
	it("refuses a fraction of a cent, in every money column", async () => {
		for (const col of ["orig_minor", "bill_minor", "home_minor", "fee_minor"] as const) {
			await expect(insertRow(db, "lines", line({ [col]: 12.5 })).run()).rejects.toThrow(/CHECK/);
		}
		await expect(insertRow(db, "evidence", evidence({ amount_minor: 0.1 })).run()).rejects.toThrow(/CHECK/);
	});

	it("never stores money as text: a whole-number string becomes an integer, a decimal string is refused", async () => {
		// SQLite's INTEGER affinity turns "1000" into 1000 BEFORE the CHECK runs — stored correctly.
		await insertRow(db, "lines", line({ id: "txt", home_minor: "1000" as unknown as number })).run();
		expect(db.raw.prepare("SELECT typeof(home_minor) AS t FROM lines WHERE id = 'txt'").get()).toEqual({ t: "integer" });
		await expect(insertRow(db, "lines", line({ home_minor: "12.50" as unknown as number })).run()).rejects.toThrow(/CHECK/);
	});

	it("refuses a flag that is not 0 or 1, and a line on an account that does not exist", async () => {
		await expect(insertRow(db, "lines", line({ flag_missed_by_alerts: 2 as 1 })).run()).rejects.toThrow(/CHECK/);
		await expect(insertRow(db, "lines", line({ account_id: "nope" })).run()).rejects.toThrow(/FOREIGN KEY/);
	});

	it("stores the same evidence once", async () => {
		const ev = evidence({ fingerprint: "same" });
		expect((await insertRow(db, "evidence", ev, true).run()).meta.changes).toBe(1);
		expect((await insertRow(db, "evidence", { ...ev, id: "other" }, true).run()).meta.changes).toBe(0);
	});

	it("keeps one statement per account and closing date", async () => {
		await insertRow(db, "statements", statement({ id: "s1", account_id: CARD_A.id })).run();
		expect((await insertRow(db, "statements", statement({ id: "s2", account_id: CARD_A.id }), true).run()).meta.changes).toBe(0);
	});

	it("ships the bank default markups, with a fallback", async () => {
		const rows = db.raw.prepare("SELECT institution FROM fx_markup_defaults ORDER BY institution").all() as { institution: string }[];
		expect(rows.map((r) => r.institution)).toEqual(["*", "citi", "dbs", "hsbc", "taishin"]);
	});
});

describe("history is append-only", () => {
	it("no code ever updates or deletes line_events, a playbook version, or an escalation's history", () => {
		const dir = fileURLToPath(new URL("../src/", import.meta.url));
		const offenders = readdirSync(dir)
			.filter((f) => f.endsWith(".ts"))
			.filter((f) => /(UPDATE|DELETE FROM)\s+(line_events|playbook_versions)\b/i.test(readFileSync(dir + f, "utf8")));
		expect(offenders).toEqual([]);
	});
});

describe("the playbook's versions", () => {
	it("publishes, refuses a stale author, and moves the head only forward from where the author started", async () => {
		const v1 = { ...emptyPlaybook(), summary: "first" };
		expect(await publishPlaybook(db, v1, null, "senior", "backfill", "2026-10-09T00:00:00.000Z")).toEqual({ ok: true, version: 1 });
		// Someone who also started from nothing is too late.
		expect(await publishPlaybook(db, { ...v1, summary: "rival" }, null, "senior", "backfill", "2026-10-09T00:00:01.000Z")).toEqual({ ok: false, reason: "conflict", head: 1 });
		expect(await publishPlaybook(db, { ...v1, summary: "second" }, 1, "senior", "escalation", "2026-10-09T00:00:02.000Z")).toEqual({ ok: true, version: 2 });
		// Starting from an old version is refused too.
		expect(await publishPlaybook(db, { ...v1, summary: "stale" }, 1, "senior", "escalation", "2026-10-09T00:00:03.000Z")).toMatchObject({ ok: false, reason: "conflict", head: 2 });
		expect(await publishPlaybook(db, { ...v1, schema: 9 as 1 }, 2, "senior", "x", "2026-10-09T00:00:04.000Z")).toMatchObject({ ok: false, reason: "invalid" });

		const head = await readHead(db);
		expect(head).toMatchObject({ version: 2, body: { summary: "second" } });
		expect(head!.body_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM playbook_versions").get()).toEqual({ n: 2 });
	});

	it("reads no head before the first version", async () => {
		expect(await readHead(db)).toBeNull();
	});
});
