/// seed/accounts.example.sql — what `npm run seed:sql` makes from the example
/// accounts — must always match seed/accounts.example.json, and load cleanly.
/// UPDATE_SEED_SQL=1 npx vitest run test/seed-sql.test.ts rewrites it.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seedSql, type SeedFile } from "../src/seed";
import { freshDb } from "./helpers/sqlite-db";

const json = new URL("../seed/accounts.example.json", import.meta.url);
const sqlFile = new URL("../seed/accounts.example.sql", import.meta.url);

describe("seed/accounts.example.sql", () => {
	it("is current with accounts.example.json and loads twice without change", () => {
		const sql = seedSql(JSON.parse(readFileSync(json, "utf8")) as SeedFile);
		if (process.env.UPDATE_SEED_SQL) writeFileSync(sqlFile, sql);
		expect(readFileSync(sqlFile, "utf8")).toBe(sql);
		const db = freshDb();
		db.raw.exec(sql);
		const n = db.raw.prepare("SELECT COUNT(*) AS n FROM accounts").get();
		db.raw.exec(sql);
		expect(db.raw.prepare("SELECT COUNT(*) AS n FROM accounts").get()).toEqual(n);
		expect((n as { n: number }).n).toBeGreaterThan(3);
		db.close();
	});
});
