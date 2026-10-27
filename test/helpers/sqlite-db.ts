/// A D1-shaped door onto a real in-memory SQLite database with every migration
/// in migrations/ applied in filename order — so the tests exercise the actual
/// schema: the money-is-an-integer CHECKs, the UNIQUE keys that make dedup
/// work, and the foreign keys (on by default in node:sqlite, as in D1).
/// Nothing here can reach a real database: it exists only in memory.

import { BANKS_UPSERT, banksValues, type SeedFile } from "../../src/seed";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Bound, Db, RunResult } from "../../src/db";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));
const EXAMPLE_SEED = fileURLToPath(new URL("../../seed/accounts.example.json", import.meta.url));

export const D1_MAX_BOUND = 100;

export type TestDb = Db & { close(): void; raw: DatabaseSync };

/// `banks` (default true): the example seed's bank list (DBS, HSBC, Citi, 台新 and
/// their mail domains) is loaded, as a real install loads its seed — so mail from
/// those made-up-world banks is trusted exactly as before the list became data.
/// A test about other banks loads its own seed (seedSql), which replaces it.
export function freshDb(opts: { banks?: boolean } = {}): TestDb {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(MIGRATIONS + file, "utf8"));
	}
	if (opts.banks !== false) {
		const seed = JSON.parse(readFileSync(EXAMPLE_SEED, "utf8")) as SeedFile;
		sqlite.prepare(BANKS_UPSERT).run(...(banksValues(seed, "2026-01-01T00:00:00.000Z") as never[]));
	}
	const prepare = (sql: string) => ({
		bind(...values: unknown[]): Bound {
			// D1 refuses a statement with more than 100 bound values; so does this.
			if (values.length > D1_MAX_BOUND) throw new Error(`D1 limit: ${values.length} bound values (max ${D1_MAX_BOUND})`);
			// D1 refuses `undefined` outright (D1_TYPE_ERROR); so does this, so a
			// missing field is caught here and not on the live database.
			if (values.some((v) => v === undefined)) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported");
			const args = values.map((v) => (typeof v === "boolean" ? Number(v) : v)) as never[];
			return {
				async first<T>() {
					return (sqlite.prepare(sql).get(...args) as T | undefined) ?? null;
				},
				async all<T>() {
					return { results: sqlite.prepare(sql).all(...args) as T[] };
				},
				async run(): Promise<RunResult> {
					const r = sqlite.prepare(sql).run(...args);
					return { meta: { changes: Number(r.changes) } };
				},
			};
		},
	});
	return {
		prepare,
		async batch(statements: Bound[]): Promise<RunResult[]> {
			// D1 runs a batch as one transaction: all or nothing.
			sqlite.exec("BEGIN");
			try {
				const out: RunResult[] = [];
				for (const s of statements) out.push(await s.run());
				sqlite.exec("COMMIT");
				return out;
			} catch (e) {
				sqlite.exec("ROLLBACK");
				throw e;
			}
		},
		close() {
			sqlite.close();
		},
		raw: sqlite,
	};
}
