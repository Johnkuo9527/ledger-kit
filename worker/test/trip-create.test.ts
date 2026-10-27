/// The owner starts his own trip (POST /api/trips, ledger_confirm_trip action "create"),
/// then adds or removes any line.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { line } from "../../test/helpers/fixtures";
import { addAccounts, put } from "../../test/helpers/world";
import { makeOp, tripOp } from "../src/ops";
import { makeDeps, makeEnv } from "./helpers/harness";

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
beforeEach(async () => {
	db = freshDb();
	D = makeDeps();
	await addAccounts(db);
});
afterEach(() => db.close());

const op = () => makeOp(makeEnv(db), D, "owner");
const ids = (r: unknown) => ((r as { lines: { id: string }[] }).lines.map((l) => l.id)).sort();

describe("The owner's own trip", () => {
	it("is confirmed at once; its overseas spending in the dates joins; he adds and removes any line", async () => {
		await put(db, "lines", line({ id: "jp1", txn_date: "2026-10-03", orig_currency: "JPY", orig_minor: 18000, merchant_country: "JP" }));
		await put(db, "lines", line({ id: "jp2", txn_date: "2026-10-07", orig_currency: "JPY", orig_minor: 800, merchant_country: "JP" }));
		await put(db, "lines", line({ id: "home", txn_date: "2026-10-05" })); // SGD at home: not by itself
		await put(db, "lines", line({ id: "later", txn_date: "2026-10-09", orig_currency: "JPY", orig_minor: 500, merchant_country: "JP" }));
		const r = await tripOp(await op(), { action: "create", name: "Japan Trip 1 Oct - 7 Oct", start_date: "2026-10-01", end_date: "2026-10-07", destination: "Japan" });
		expect(r).toMatchObject({ trip: { name: "Japan Trip 1 Oct - 7 Oct", destination: "Japan", status: "confirmed", start_date: "2026-10-01", end_date: "2026-10-07" } });
		expect(ids(r)).toEqual(["jp1", "jp2"]);
		const id = (r as { trip: { id: string } }).trip.id;
		const edited = await tripOp(await op(), { action: "edit", trip_id: id, include_line_ids: ["home", "later"], exclude_line_ids: ["jp2"] });
		expect(ids(edited)).toEqual(["home", "jp1", "later"]);
		// The trip can be found by name too.
		expect(ids(await tripOp(await op(), { action: "edit", trip_id: "Japan Trip", include_line_ids: ["jp2"] }))).toEqual(["home", "jp1", "jp2", "later"]);
	});

	it("refuses a trip with no name or with its dates the wrong way round", async () => {
		await expect(tripOp(await op(), { action: "create", name: " ", start_date: "2026-10-01", end_date: "2026-10-07" })).rejects.toThrow(/name/);
		await expect(tripOp(await op(), { action: "create", name: "X", start_date: "2026-10-08", end_date: "2026-10-07" })).rejects.toThrow(/ends before it starts/);
	});
});
