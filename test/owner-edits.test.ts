/// The owner's edits that are not ledger lines: trips, subscriptions,
/// reimbursable ranges, Apple Wallet card names. Each is the owner's word, so each
/// is refused — never half-applied, never overwritten — when the row moved
/// underneath him.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bound, Db } from "../src/db";
import { addWalletName, correctHome, editTrip, ingestTap, removeReimburseRange, setReimbursable, setSubscriptionStatus, setTripStatus, type Engine } from "../src/engine";
import { Refused } from "../src/refused";
import { BANK, CARD_A, CARD_B, line } from "./helpers/fixtures";
import { freshDb, type TestDb } from "./helpers/sqlite-db";
import { addAccounts, put, subscriptionRow, testEngine, tripRow } from "./helpers/world";

let db: TestDb;
let e: Engine;
beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
	e = testEngine(db, "owner");
});
afterEach(() => db.close());

const trip = async (id: string) => (await db.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<Record<string, unknown>>())!;
const tripLines = async (id: string) => (await db.prepare("SELECT line_id, membership FROM trip_lines WHERE trip_id = ? ORDER BY line_id").bind(id).all()).results;

describe("a trip's status", () => {
	beforeEach(() => put(db, "trips", tripRow({ id: "T" })));

	it("proposed → confirmed, stamped; confirming again changes nothing", async () => {
		await setTripStatus(e, "T", "confirm");
		const first = await trip("T");
		expect(first).toMatchObject({ status: "confirmed" });
		expect(first.confirmed_at).toMatch(/^2026-10-09T/);
		await setTripStatus(e, "T", "confirm");
		expect(await trip("T")).toEqual(first);
	});

	it("dismissed → restored to proposed; the moves the contract does not allow are refused in words", async () => {
		await setTripStatus(e, "T", "dismiss");
		expect((await trip("T")).status).toBe("dismissed");
		await expect(setTripStatus(e, "T", "confirm")).rejects.toThrow("a dismissed trip cannot be confirmed");
		await setTripStatus(e, "T", "restore");
		expect((await trip("T")).status).toBe("proposed");
		await expect(setTripStatus(e, "T", "restore")).rejects.toThrow("a proposed trip cannot be restored");
		await setTripStatus(e, "T", "confirm");
		await expect(setTripStatus(e, "T", "dismiss")).rejects.toBeInstanceOf(Refused);
		await expect(setTripStatus(e, "nope", "confirm")).rejects.toThrow("no such trip");
	});

	it("refuses, and writes nothing, when the trip moved between the read and the write", async () => {
		// The daily run (or a second tab) dismisses it just before the owner's confirm lands.
		const racing: Db = {
			prepare(sql: string) {
				const stmt = db.prepare(sql);
				if (!sql.startsWith("UPDATE trips SET status")) return stmt;
				return {
					bind(...v: unknown[]): Bound {
						const b = stmt.bind(...v);
						return {
							...b,
							async run() {
								db.raw.exec("UPDATE trips SET status = 'dismissed' WHERE id = 'T'");
								return b.run();
							},
						};
					},
				};
			},
			batch: (s) => db.batch(s),
		};
		await expect(setTripStatus({ ...e, db: racing }, "T", "confirm")).rejects.toThrow(/changed while you were looking/);
		expect((await trip("T")).status).toBe("dismissed");
	});
});

describe("editing a trip", () => {
	beforeEach(async () => {
		await put(db, "trips", tripRow({ id: "T", name: "Old" }));
		await put(db, "lines", line({ id: "A" }));
		await put(db, "lines", line({ id: "B" }));
	});

	it("renames, moves the dates, and records the owner's include/exclude — a later choice replaces an earlier one", async () => {
		await editTrip(e, "T", { name: "  Tokyo  ", start_date: "2026-03-08", end_date: "2026-03-14", include_line_ids: ["A"], exclude_line_ids: ["B"] });
		expect(await trip("T")).toMatchObject({ name: "Tokyo", start_date: "2026-03-08", end_date: "2026-03-14", status: "proposed" });
		expect(await tripLines("T")).toEqual([
			{ line_id: "A", membership: "included" },
			{ line_id: "B", membership: "excluded" },
		]);
		await editTrip(e, "T", { include_line_ids: ["B"], name: "" });
		expect(await tripLines("T")).toEqual([
			{ line_id: "A", membership: "included" },
			{ line_id: "B", membership: "included" },
		]);
		expect((await trip("T")).name).toBeNull();
	});

	it("refuses bad dates, unknown lines, a line both ways, and a dismissed trip — and changes nothing", async () => {
		await expect(editTrip(e, "T", { start_date: "2026-03-20" })).rejects.toThrow("the trip ends before it starts");
		await expect(editTrip(e, "T", { end_date: "13 March" })).rejects.toThrow("YYYY-MM-DD");
		await expect(editTrip(e, "T", { include_line_ids: ["A", "ghost"] })).rejects.toThrow("no such line: ghost");
		await expect(editTrip(e, "T", { include_line_ids: ["A"], exclude_line_ids: ["A"] })).rejects.toThrow("both included and excluded");
		expect(await tripLines("T")).toEqual([]);
		expect((await trip("T")).name).toBe("Old");
		await setTripStatus(e, "T", "dismiss");
		await expect(editTrip(e, "T", { name: "x" })).rejects.toThrow("restore it first");
	});

	it("checks 150 line ids in one bound value (D1 refuses more than 100)", async () => {
		const many = Array.from({ length: 150 }, (_, i) => `ghost-${i}`);
		await expect(editTrip(e, "T", { exclude_line_ids: many })).rejects.toThrow(/no such line: ghost-0, /);
	});
});

describe("subscriptions and reimbursable ranges", () => {
	it("ignore / cancelled / restore set the owner's word; an unknown one is refused", async () => {
		await put(db, "subscriptions", subscriptionRow({ id: "S", merchant_key: "STREAMCO" }));
		const word = async () => (await db.prepare("SELECT owner_status FROM subscriptions WHERE id = 'S'").bind().first<{ owner_status: string | null }>())!.owner_status;
		await setSubscriptionStatus(e, "S", "ignore");
		expect(await word()).toBe("ignored");
		await setSubscriptionStatus(e, "S", "cancelled");
		expect(await word()).toBe("cancelled");
		await setSubscriptionStatus(e, "S", "restore");
		expect(await word()).toBeNull();
		await expect(setSubscriptionStatus(e, "nope", "ignore")).rejects.toThrow("no such subscription");
	});

	it("a range can be removed once", async () => {
		await put(db, "reimburse_ranges", { id: "R", start_date: "2026-03-01", end_date: "2026-03-02", note: null, created_at: "2026-01-01T00:00:00.000Z" });
		await removeReimburseRange(e, "R");
		await expect(removeReimburseRange(e, "R")).rejects.toThrow("no such reimbursable range");
	});

	it("the existing line edits refuse in words too", async () => {
		await expect(setReimbursable(e, "nope", 1)).rejects.toBeInstanceOf(Refused);
		await expect(correctHome(e, "nope", 100)).rejects.toBeInstanceOf(Refused);
	});
});

describe("Apple Wallet card names", () => {
	const tap = { card: "Mystery Card", merchant: "Kopi Corner", amount: "S$4.50", timestamp: "2026-03-05T08:15:00+08:00" };

	it("a held tap becomes a line once its Wallet name is given to a card — filed by the rules, not by the owner", async () => {
		const held = await ingestTap(testEngine(db), tap);
		expect(held).toMatchObject({ status: "held" });
		const r = await addWalletName(e, "  mystery-card ", CARD_A.id);
		expect(r.wallet_key).toBe("MYSTERY CARD");
		expect(r.retried).toHaveLength(1);
		expect(r.retried[0]).toMatchObject({ status: "created" });
		const lineId = (r.retried[0] as { line_id: string }).line_id;
		expect(await db.prepare("SELECT account_id, bill_minor, created_by FROM lines WHERE id = ?").bind(lineId).first()).toEqual({ account_id: CARD_A.id, bill_minor: 450, created_by: "rules" });
		expect(await db.prepare("SELECT status FROM escalations WHERE kind = 'unknown_wallet_card'").bind().first()).toEqual({ status: "resolved" });
		// Saying it again is harmless.
		expect((await addWalletName(e, "Mystery Card", CARD_A.id)).retried).toEqual([]);
	});

	it("never moves a name to another card, never names a bank account, never names nothing", async () => {
		await addWalletName(e, "Blue Card", CARD_A.id);
		await expect(addWalletName(e, "BLUE  card", CARD_B.id)).rejects.toThrow("already belongs to another card");
		await expect(addWalletName(e, "Bank", BANK.id)).rejects.toThrow("only a card");
		await expect(addWalletName(e, " -- ", CARD_A.id)).rejects.toThrow("empty");
		await expect(addWalletName(e, "X", "nope")).rejects.toThrow("no such account");
		expect(await db.prepare("SELECT account_id FROM account_wallet_names WHERE wallet_key = 'BLUE CARD'").bind().first()).toEqual({ account_id: CARD_A.id });
	});
});

describe("review fixes", () => {
	it("confirming with corrections is ONE write: a status change in between refuses the whole thing", async () => {
		await put(db, "trips", tripRow({ id: "T" }));
		await editTrip(e, "T", { end_date: "2026-03-15", confirm: true });
		const t = await trip("T");
		expect(t).toMatchObject({ status: "confirmed", end_date: "2026-03-15" });
		expect(t.confirmed_at).toBe(t.owner_edited_at);
		// Already confirmed: corrections still land, and the first confirmation's stamp is kept.
		await editTrip(e, "T", { name: "Later", confirm: true });
		expect(await trip("T")).toMatchObject({ name: "Later", status: "confirmed", confirmed_at: t.confirmed_at });
		await put(db, "trips", tripRow({ id: "D", status: "dismissed" }));
		await expect(editTrip(e, "D", { name: "x", confirm: true })).rejects.toThrow("a dismissed trip cannot be confirmed");
	});

	it("an edit marks the trip as the owner's (owner_edited_at), so the daily proposals leave it alone", async () => {
		await put(db, "trips", tripRow({ id: "T" }));
		expect((await trip("T")).owner_edited_at).toBeNull();
		await editTrip(e, "T", { name: "Mine" });
		expect((await trip("T")).owner_edited_at).toMatch(/^2026-10-09T/);
	});

	it("naming a card retries only that card's held taps, a few at a time, and says how many are left", async () => {
		const tapE = testEngine(db);
		for (let i = 0; i < 6; i++) await ingestTap(tapE, { card: "Six Taps", merchant: `Shop ${i}`, amount: `S$${i + 1}.00`, timestamp: `2026-03-0${i + 1}T08:00:00+08:00` });
		await ingestTap(tapE, { card: "Other Card", merchant: "Elsewhere", amount: "S$9.00", timestamp: "2026-03-09T08:00:00+08:00" });
		const named = await addWalletName({ ...e, newId: () => crypto.randomUUID() }, "Six Taps", CARD_A.id);
		expect(named.retried).toHaveLength(4);
		expect(named.still_held).toBe(2);
		// Oldest first.
		expect(await db.prepare("SELECT COUNT(*) AS n FROM lines WHERE merchant_raw IN ('Shop 0', 'Shop 1', 'Shop 2', 'Shop 3')").bind().first()).toEqual({ n: 4 });
		const again = await addWalletName({ ...e, newId: () => crypto.randomUUID() }, "Six Taps", CARD_A.id);
		expect(again).toMatchObject({ still_held: 0 });
		expect(again.retried).toHaveLength(2);
		// The other card's tap was never touched.
		expect(await db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE type = 'apple_pay_shortcut' AND line_id IS NULL").bind().first()).toEqual({ n: 1 });
	});
});
