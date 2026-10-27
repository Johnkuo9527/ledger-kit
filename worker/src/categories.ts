/// The owner's category list: add, rename, delete (23 Oct 2026 — the owner: 「現在可以加新的分類 但根本無法改名字
/// 不夠方便 也刪不掉 如果刪掉的分類有牽連到已分類記得提醒使用者然後讓他確定然後在刪除前給新的分類」).
///
/// A category's name lives in six places, and a rename or a delete moves ALL of them in ONE D1 batch
/// (a transaction), so nothing is ever left pointing at a name that is gone:
///   1. every line in it (void ones too), each with a line event — the owner's word, counted at once;
///   2. The owner's payee rules (payee_rules.category);
///   3. the playbook's merchant → category map and its category list (else the reader keeps
///      writing the old name on new lines) — published as a new version inside the same batch;
///   4. a wallet's default category for a purchase the owner tells, and the category its pre-counted
///      top-ups were counted in (accounts.wallet_spend_category / wallet_precounted_category);
///   5. the list itself, stored in sync_state (CATEGORY_LIST_KEY) — from the first edit on it IS
///      his list, so a deleted starting category never comes back from LEDGER_CATEGORIES;
///   6. the page's own copies (its filter, the open picker) — redrawn from the answer.
///
/// Set-based: each place is one UPDATE however many lines (Cloudflare counts queries per request).
/// Every write in the batch is guarded on the playbook head this call published (or read), so a rule
/// published by someone else in between makes the whole batch a no-op and it is tried again.
///
/// Merging is a delete with a move: a rename onto a name already in the list is refused and says so.
///
/// A tick already running when the owner edits read the list and the rules before his edit, and can still
/// write the old name (on a line it sorts, or a shop the reader just learned). So the list remembers
/// where each old name went (`moved`), and for an hour after an edit the tick's categorise step moves
/// any old name it finds on to where it went (followLateNames) — one query a minute while it looks.

import type { Bound, Db } from "../../src/db";
import { emptyPlaybook, type Playbook } from "../../src/playbook";
import { publishStatements, readHead } from "../../src/playbook-store";
import { Refused } from "../../src/refused";
import type { Op } from "./ops";
import type { Tick } from "./tick";
import { optOneOf, text } from "./validate";

/// The owner's whole list once he has added, renamed or deleted one (sync_state, under this key): from then
/// on `names` IS his list (a deleted starting category must not come back from LEDGER_CATEGORIES);
/// `was` maps a renamed category to the name it started as (the page keeps its icon); `moved` maps
/// each old name (lower case) to where it went — null when it was deleted with nothing in it — and
/// `moved_at` says when the last edit was. Written only here.
export const CATEGORY_LIST_KEY = "category_list";

/// Old name (lower case) → the name it went to; null = deleted with nothing in it.
export type CategoryMoves = Record<string, string | null>;

export interface StoredCategories {
	names: string[];
	was: Record<string, string>;
	moved: CategoryMoves;
	moved_at: string | null;
}

/// The stored list, or null when there is none (or it is not one).
export function storedCategories(value: unknown): StoredCategories | null {
	if (!value || typeof value !== "object" || !Array.isArray((value as { names?: unknown }).names)) return null;
	const v = value as { names: unknown[]; was?: unknown; moved?: unknown; moved_at?: unknown };
	const names: string[] = [];
	for (const c of v.names) {
		if (typeof c !== "string" || !c.trim()) continue;
		if (!names.some((n) => n.toLowerCase() === c.trim().toLowerCase())) names.push(c.trim());
	}
	const was: Record<string, string> = {};
	if (v.was && typeof v.was === "object") for (const [k, x] of Object.entries(v.was)) if (typeof x === "string" && names.includes(k)) was[k] = x;
	const moved: CategoryMoves = {};
	if (v.moved && typeof v.moved === "object") for (const [k, x] of Object.entries(v.moved)) if (typeof x === "string" || x === null) moved[k.toLowerCase()] = x;
	return { names, was, moved, moved_at: typeof v.moved_at === "string" ? v.moved_at : null };
}

/// What uses a category: live lines as the owner sees them (never a wallet_offset — lists fold it; it moves
/// with the wallet's default, which counts as a rule), and rules (the owner's payee rules and the playbook's
/// merchant map, one per merchant; a wallet's default category counts as one too).
export interface CategoryUsage {
	lines: number;
	rules: number;
}

const same = (a: string | null | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/// A name the owner typed for a category: trimmed, at most 40 characters, no comma or line break.
export function categoryName(value: unknown, field: string): string {
	const name = text(value, field, 40).trim();
	if (!name || /[,\n]/.test(name)) throw new Refused("a category name cannot be empty or contain a comma");
	return name;
}

/// One of the owner's categories, as the list spells it.
function existing(op: Op, value: unknown, field: string): string {
	const asked = text(value, field, 80).trim();
	const found = op.categories.find((c) => same(c, asked));
	if (!found) throw new Refused(`'${asked}' is not one of your categories: ${op.categories.join(", ")}`);
	return found;
}

/// How much uses each of the owner's categories (keyed as the list spells it; 0/0 when nothing does).
export async function categoryUsage(op: Op): Promise<Record<string, CategoryUsage>> {
	const [lines, payees, wallets, head] = await Promise.all([
		op.db.prepare("SELECT category AS c, COUNT(*) AS n FROM lines WHERE state <> 'void' AND kind <> 'wallet_offset' AND category IS NOT NULL GROUP BY category COLLATE NOCASE").bind().all<{ c: string; n: number }>(),
		op.db.prepare("SELECT merchant_key AS k, category AS c FROM payee_rules WHERE category IS NOT NULL").bind().all<{ k: string; c: string }>(),
		op.db.prepare("SELECT wallet_spend_category AS s, wallet_precounted_category AS p FROM accounts WHERE wallet_spend_category IS NOT NULL OR wallet_precounted_category IS NOT NULL").bind().all<{ s: string | null; p: string | null }>(),
		readHead(op.db),
	]);
	const out: Record<string, CategoryUsage> = {};
	for (const c of op.categories) {
		const merchants = new Set([...payees.results.filter((r) => same(r.c, c)).map((r) => r.k), ...(head?.body.category_rules ?? []).filter((r) => same(r.category, c)).map((r) => r.merchant_key)]);
		const walletDefaults = wallets.results.filter((w) => same(w.s, c) || same(w.p, c)).length;
		out[c] = { lines: lines.results.filter((r) => same(r.c, c)).reduce((s, r) => s + r.n, 0), rules: merchants.size + walletDefaults };
	}
	return out;
}

/// The playbook with `from` moved to `to` (null: dropped).
function movedBook(book: Playbook, from: string, to: string | null): Playbook {
	const rules = book.category_rules.flatMap((r) => (same(r.category, from) ? (to ? [{ ...r, category: to }] : []) : [r]));
	const categories: string[] = [];
	for (const c of book.categories.map((c) => (same(c, from) ? to : c))) if (c && !categories.includes(c)) categories.push(c);
	for (const r of rules) if (!categories.includes(r.category)) categories.push(r.category);
	return { ...book, categories, category_rules: rules };
}

/// The moves after `from` went to `to`: a name in the list again is never "moved".
function withMove(moved: CategoryMoves, from: string, to: string | null): CategoryMoves {
	const next = { ...moved, [from.toLowerCase()]: to };
	if (to) delete next[to.toLowerCase()];
	return next;
}

/// Where an old name ended up, following renames and moves to a name in `names`: undefined when it was
/// never moved (or is in the list), null when it was deleted with nothing in it.
export function followMove(name: string, names: readonly string[], moved: CategoryMoves): string | null | undefined {
	let at = name;
	for (let hop = 0; hop < 20; hop++) {
		const live = names.find((n) => same(n, at));
		if (live) return hop ? live : undefined;
		if (!(at.toLowerCase() in moved)) return hop ? null : undefined;
		const next = moved[at.toLowerCase()];
		if (next === null || next === undefined) return null;
		at = next;
	}
	return null;
}

interface Move {
	from: string;
	to: string | null;
	event: "category_rename" | "category_delete" | "category_follow";
	actor: "owner" | "rules";
	reason: string;
}

/// Moves everything named `from` to `to` (null = no category), and stores `list` when given, in ONE batch.
/// Returns how many lines moved.
async function moveEverywhere(db: Db, now: () => string, move: Move, list: StoredCategories | null): Promise<number> {
	const { from, to } = move;
	for (let attempt = 0; ; attempt++) {
		const at = now();
		const head = await readHead(db);
		const book = head?.body ?? emptyPlaybook();
		const next = movedBook(book, from, to);
		const changed = JSON.stringify(next) !== JSON.stringify(book);
		let guardVersion = head?.version ?? null;
		const publish: Bound[] = [];
		if (changed) {
			const built = await publishStatements(db, next, head?.version ?? null, "owner", move.reason, at);
			if (!built.ok) throw new Refused(`the ledger's rules would not accept this change: ${built.problems.join("; ")}`);
			publish.push(...built.statements);
			guardVersion = built.version;
		}
		// Each write below happens only while the head is the one this call published (or read).
		const G = "(SELECT version FROM playbook_head WHERE id = 1) IS ?";
		const lineEvents = db
			.prepare(`INSERT INTO line_events (line_id, at, actor, event, before_json, after_json) SELECT id, ?, ?, ?, json_object('category', category), json_object('category', ?) FROM lines WHERE category = ? COLLATE NOCASE AND ${G}`)
			.bind(at, move.actor, move.event, to, from, guardVersion);
		const lines = db.prepare(`UPDATE lines SET category = ?, updated_at = ? WHERE category = ? COLLATE NOCASE AND ${G}`).bind(to, at, from, guardVersion);
		const payees = to
			? [db.prepare(`UPDATE payee_rules SET category = ?, updated_at = ? WHERE category = ? COLLATE NOCASE AND ${G}`).bind(to, at, from, guardVersion)]
			: [
					// No category to go to: a rule that also says the kind keeps the kind; one that only named the category goes.
					db.prepare(`UPDATE payee_rules SET category = NULL, updated_at = ? WHERE category = ? COLLATE NOCASE AND kind IS NOT NULL AND ${G}`).bind(at, from, guardVersion),
					db.prepare(`DELETE FROM payee_rules WHERE category = ? COLLATE NOCASE AND kind IS NULL AND ${G}`).bind(from, guardVersion),
				];
		const wallets = [
			db.prepare(`UPDATE accounts SET wallet_spend_category = ? WHERE wallet_spend_category = ? COLLATE NOCASE AND ${G}`).bind(to, from, guardVersion),
			db.prepare(`UPDATE accounts SET wallet_precounted_category = ? WHERE wallet_precounted_category = ? COLLATE NOCASE AND ${G}`).bind(to, from, guardVersion),
		];
		const store = list
			? [
					db
						.prepare(`INSERT INTO sync_state (key, value, updated_at) SELECT ?, ?, ? WHERE ${G} ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
						.bind(CATEGORY_LIST_KEY, JSON.stringify({ ...list, moved_at: at }), at, guardVersion),
				]
			: [];
		let results;
		try {
			results = await db.batch([...publish, lineEvents, lines, ...payees, ...wallets, ...store]);
		} catch (e) {
			if (!changed || attempt >= 2) throw e; // two publishers took the same version number: the second tries again
			continue;
		}
		if (!changed || results[0]!.meta.changes === 1) return results[publish.length + 1]!.meta.changes; // the lines UPDATE
		if (attempt >= 2) throw new Refused("the ledger's rules were being changed at the same moment; try again");
	}
}

/// The owner's change to his list, made: everything moved and the list stored, then the request's own copy follows.
async function ownerMoves(op: Op, move: Omit<Move, "actor">, list: StoredCategories): Promise<number> {
	const moved = await moveEverywhere(op.db, op.engine.now, { ...move, actor: "owner" }, list);
	op.categories = list.names;
	op.categoryWas = list.was;
	op.categoryMoved = list.moved;
	return moved;
}

export interface CategoryEdit {
	categories: string[];
	was: Record<string, string>;
	/// Lines that moved (void ones included) — the page reloads when any did.
	moved_lines: number;
}

/// The owner renames a category: everything named it follows (see the top of this file).
export async function renameCategory(op: Op, input: Record<string, unknown>): Promise<CategoryEdit> {
	const from = existing(op, input.rename, "rename");
	const to = categoryName(input.to, "to");
	if (to === from) return { categories: op.categories, was: op.categoryWas, moved_lines: 0 };
	const taken = op.categories.find((c) => c !== from && same(c, to));
	if (taken) throw new Refused(`'${taken}' is already one of your categories. To put everything in '${from}' into '${taken}', delete '${from}' and move it to '${taken}'`);
	const was = { ...op.categoryWas };
	was[to] = was[from] ?? from;
	delete was[from];
	const list = { names: op.categories.map((c) => (c === from ? to : c)), was, moved: withMove(op.categoryMoved, from, to), moved_at: null };
	const moved = await ownerMoves(op, { from, to, event: "category_rename", reason: `the owner: category ${from} renamed ${to}` }, list);
	return { categories: op.categories, was: op.categoryWas, moved_lines: moved };
}

/// The owner deletes a category. When anything uses it, `move_to` (another of his categories) is required
/// and everything moves there first, in the same step; when nothing does, it simply goes.
export async function deleteCategory(op: Op, input: Record<string, unknown>): Promise<CategoryEdit & { moved_to: string | null }> {
	const name = existing(op, input.delete, "delete");
	const target = input.move_to === undefined || input.move_to === null || input.move_to === "" ? null : existing(op, input.move_to, "move_to");
	if (target === name) throw new Refused(`'${name}' cannot be moved into itself; choose another category`);
	if (op.categories.length <= 1) throw new Refused("you need at least one category; add another before deleting this one");
	if (!target) {
		const use = (await categoryUsage(op))[name]!;
		if (use.lines || use.rules) {
			const what = [use.lines ? `${use.lines} line${use.lines === 1 ? "" : "s"}` : "", use.rules ? `${use.rules} rule${use.rules === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
			throw new Refused(`'${name}' is used by ${what}; say which category they move to (move_to: one of ${op.categories.filter((c) => c !== name).join(", ")})`);
		}
	}
	const was = { ...op.categoryWas };
	delete was[name];
	const list = { names: op.categories.filter((c) => c !== name), was, moved: withMove(op.categoryMoved, name, target), moved_at: null };
	const reason = target ? `the owner: category ${name} deleted, moved to ${target}` : `the owner: category ${name} deleted`;
	const moved = await ownerMoves(op, { from: name, to: target, event: "category_delete", reason }, list);
	return { categories: op.categories, was: op.categoryWas, moved_lines: moved, moved_to: target };
}

/// The owner adds a category of his own; from then on the stored list is his list.
export async function addCategory(op: Op, input: unknown): Promise<void> {
	const name = categoryName(input, "add");
	if (op.categories.some((c) => same(c, name))) throw new Refused(`'${name}' is already one of your categories`);
	const moved = { ...op.categoryMoved };
	delete moved[name.toLowerCase()];
	const names = [...op.categories, name];
	await op.db
		.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
		.bind(CATEGORY_LIST_KEY, JSON.stringify({ names, was: op.categoryWas, moved, moved_at: op.engine.now() }), op.engine.now())
		.run();
	op.categories = names;
	op.categoryMoved = moved;
}

/// How long after an edit the tick still looks for an old name a tick already running wrote late.
export const FOLLOW_MOVES_MS = 3_600_000;

/// The tick's half of an edit (see the top of this file): an old name a late writer left on a line, a
/// payee rule, a wallet or the playbook moves on to where it went. Returns how many lines moved.
export async function followLateNames(t: Tick): Promise<number> {
	const stored = storedCategories(t.get<unknown>(CATEGORY_LIST_KEY));
	if (!stored?.moved_at || t.now().getTime() - Date.parse(stored.moved_at) > FOLLOW_MOVES_MS) return 0;
	const old = Object.keys(stored.moved);
	if (!old.length || !t.room(20)) return 0;
	const json = JSON.stringify(old);
	const IN = "IN (SELECT value FROM json_each(?))";
	const found = (
		await t.db
			.prepare(
				`SELECT category AS c FROM lines WHERE lower(category) ${IN} UNION SELECT category FROM payee_rules WHERE lower(category) ${IN} ` +
					`UNION SELECT wallet_spend_category FROM accounts WHERE lower(wallet_spend_category) ${IN} UNION SELECT wallet_precounted_category FROM accounts WHERE lower(wallet_precounted_category) ${IN}`,
			)
			.bind(json, json, json, json)
			.all<{ c: string }>()
	).results.map((r) => r.c);
	t.forgetHead(); // a sort or an escalation may have published since this tick read it
	const book = (await t.head())?.body;
	for (const name of [...(book?.category_rules ?? []).map((r) => r.category), ...(book?.categories ?? [])]) if (old.includes(name.toLowerCase())) found.push(name);
	let lines = 0;
	const done = new Set<string>();
	for (const name of found) {
		if (done.has(name.toLowerCase()) || !t.room(12)) continue;
		done.add(name.toLowerCase());
		const to = followMove(name, stored.names, stored.moved);
		if (to === undefined) continue;
		lines += await moveEverywhere(t.db, () => t.iso(), { from: name, to, event: "category_follow", actor: "rules", reason: `following the owner's category change: ${name} → ${to ?? "(none)"}` }, null);
		t.forgetHead();
	}
	if (lines) t.count("lines_category_followed", lines);
	return lines;
}

export const CATEGORY_ACTIONS = ["list", "rename", "delete"] as const;

/// The connector's ledger_categories: list (with what uses each), rename, or delete with a move.
export async function categoriesToolOp(op: Op, input: Record<string, unknown>): Promise<object> {
	const action = optOneOf(input.action, CATEGORY_ACTIONS, "action") ?? "list";
	if (action === "list") return { categories: op.categories, usage: await categoryUsage(op) };
	const category = text(input.category, "category", 80);
	if (action === "rename") return renameCategory(op, { rename: category, to: categoryName(input.new_name, "new_name") });
	return deleteCategory(op, { delete: category, move_to: input.move_to });
}
