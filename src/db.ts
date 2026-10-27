/// The database door. A structural slice of Cloudflare D1's API, so the worker
/// passes `env.LEDGER_DB` straight in, and the tests pass a real SQLite
/// database with the real migration applied (test/helpers/sqlite-db.ts) — the
/// CHECK constraints, UNIQUE keys and foreign keys are tested for real.
///
/// D1 has no interactive transactions: `batch` is the only atomic unit. Any
/// write that must not be half-done (a line AND the evidence that made it)
/// goes in one batch.

export interface RunResult {
	meta: { changes: number };
}
export interface Bound {
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<RunResult>;
}
export interface Stmt {
	bind(...values: unknown[]): Bound;
}
export interface Db {
	prepare(sql: string): Stmt;
	batch(statements: Bound[]): Promise<RunResult[]>;
}

/// INSERT for a whole row object whose keys are the column names.
export function insertRow(db: Db, table: string, row: object, orIgnore = false): Bound {
	const cols = Object.keys(row);
	const sql = `INSERT ${orIgnore ? "OR IGNORE " : ""}INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
	return db.prepare(sql).bind(...Object.values(row));
}

/// UPDATE some columns of one row by id.
export function updateById(db: Db, table: string, id: string, changes: object): Bound {
	const cols = Object.keys(changes);
	if (cols.length === 0) throw new Error("nothing to update");
	const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
	return db.prepare(sql).bind(...Object.values(changes), id);
}

export function placeholders(n: number): string {
	return Array.from({ length: n }, () => "?").join(", ");
}
