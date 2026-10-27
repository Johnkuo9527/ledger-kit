/// Categories. The owner names his own list (LEDGER_CATEGORIES); every spending
/// line ends up in one of them:
///
///   sortMerchants  each tick, up to SORT_BATCH merchants that have no rule
///                  yet go to the senior reader, which must answer with one of
///                  The owner's categories; the answers become playbook rules.
///   categorise     each tick, the playbook's rules are filled into lines that
///                  have no category yet; the owner's own merchant rules also move
///                  lines a model's rule had put elsewhere. A line already categorised — by a
///                  rule or by the owner — is never touched, so a quiet minute costs
///                  a query or two.
///
/// The owner's word wins: a rule he set (`by: "owner"`) is never replaced or dropped
/// by a model, and a line he put in a category himself never moves.
///
/// People are different: what the owner pays a person for varies, so a payee the
/// reader marks as a person (playbook `person_keys`) gets no rule — the owner picks
/// per line on his page — unless he says "always" for that person.

import { formatMoney } from "../../src/money";
import { homeCurrency } from "../../src/home";
import * as z from "zod/v4";
import { applyCategoryRules, enforceOwnerRules } from "../../src/engine";
import { emptyPlaybook, type Playbook } from "../../src/playbook";
import { publishPlaybook } from "../../src/playbook-store";
import { CATEGORY_LIST_KEY, followLateNames, storedCategories } from "./categories";
import type { LedgerEnv } from "./env";
import { engineFor, readWith } from "./pipeline";
import { fence } from "./read";
import { sha256Hex } from "./reader";
import type { Step, Tick } from "./tick";

/// Lines categorised per tick (each costs an UPDATE and its event).
export const CATEGORISE_PER_TICK = 100;
/// Merchants sent to the senior reader in one call.
export const SORT_BATCH = 60;
/// After a failed sorting call, wait this long before paying for another.
const SORT_BACKOFF_MS = 3_600_000;
/// The kinds of line that are spending and so take a category.
const SPENDING_KINDS = ["purchase", "refund", "fee", "rebate"] as const;

/// The owner's categories, in his order (comma-separated; empty = categories off).
export function fixedCategories(env: Pick<LedgerEnv, "LEDGER_CATEGORIES">): string[] {
	return [...new Set((env.LEDGER_CATEGORIES ?? "").split(",").map((c) => c.trim()).filter(Boolean))];
}

/// Categories the owner adds himself (on his page or through the connector), kept
/// in sync_state under this key as a JSON list: his list = the var's, then these.
export const OWNER_CATEGORIES_KEY = "owner_categories";

/// The owner's whole list: the stored one when there is one; else LEDGER_CATEGORIES,
/// then the ones he added (no repeats).
export function categoryList(env: Pick<LedgerEnv, "LEDGER_CATEGORIES">, added: unknown, stored?: unknown): string[] {
	const kept = storedCategories(stored);
	if (kept) return kept.names;
	const extra = Array.isArray(added) ? added.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim()) : [];
	const base = fixedCategories(env);
	return [...base, ...extra.filter((c) => !base.some((b) => b.toLowerCase() === c.toLowerCase()))];
}

/// The list as a tick sees it (its state already holds the owner's additions).
export function tickCategories(t: Tick): string[] {
	return categoryList(t.env, t.get<string[]>(OWNER_CATEGORIES_KEY), t.get<unknown>(CATEGORY_LIST_KEY));
}

/// A playbook held to the owner's list: categories = his list (plus any category
/// his own rules use), and only rules that land in it — or are his — remain.
export function constrainToList(book: Playbook, fixed: readonly string[]): Playbook {
	if (!fixed.length) return book;
	const owner = book.category_rules.filter((r) => r.by === "owner");
	const categories = [...new Set([...fixed, ...owner.map((r) => r.category)])];
	return { ...book, categories, category_rules: book.category_rules.filter((r) => r.by === "owner" || fixed.includes(r.category)) };
}

/// Model rules added to a playbook: never over a rule the owner set for that merchant.
export function addModelRules(book: Playbook, rules: readonly { merchant_key: string; category: string }[]): Playbook {
	let next = book.category_rules;
	for (const r of rules) {
		if (next.some((x) => x.merchant_key === r.merchant_key && x.by === "owner")) continue;
		next = [...next.filter((x) => x.merchant_key !== r.merchant_key), { merchant_key: r.merchant_key, category: r.category }];
	}
	return { ...book, category_rules: next };
}

/// Payees marked as people: never given a rule by a model (the owner picks per line).
export function addPeople(book: Playbook, keys: readonly string[]): Playbook {
	if (!keys.length) return book;
	return { ...book, person_keys: [...new Set([...(book.person_keys ?? []), ...keys])] };
}

/// Is this payee a person? Only when a model said so and the owner has no rule for it.
export function isPerson(book: Playbook | null | undefined, merchantKey: string | null): boolean {
	if (!book || !merchantKey) return false;
	return (book.person_keys ?? []).includes(merchantKey) && !book.category_rules.some((r) => r.merchant_key === merchantKey && r.by === "owner");
}

interface Unsorted {
	merchant_key: string;
	name: string | null;
	raw: string | null;
	country: string | null;
	kind: string;
	on_card: number; // 1 = every line is on a card: a shop, never a person
	n: number;
	home_minor: number | null;
}

export const sortMerchants: Step = {
	name: "sort_merchants",
	async run(t) {
		const fixed = tickCategories(t);
		if (!fixed.length || (!t.svc.claude && !t.subscription) || !t.room(20)) return;
		const failedAt = t.get<string>("sort_failed_at");
		if (failedAt && t.now().getTime() - Date.parse(failedAt) < SORT_BACKOFF_MS) return;
		const head = await t.head();
		const ruled = new Set([...(head?.body.category_rules ?? []).filter((r) => fixed.includes(r.category) || r.by === "owner").map((r) => r.merchant_key), ...(head?.body.person_keys ?? [])]);
		const rows = (
			await t.db
				.prepare(
					`SELECT l.merchant_key, MAX(l.merchant_name) AS name, MAX(l.merchant_raw) AS raw, MAX(l.merchant_country) AS country, MAX(l.kind) AS kind, MIN(a.kind IN ('credit_card', 'debit_card')) AS on_card, COUNT(*) AS n, SUM(l.home_minor) AS home_minor FROM lines l JOIN accounts a ON a.id = l.account_id WHERE l.category IS NULL AND l.state <> 'void' AND l.merchant_key IS NOT NULL AND l.kind IN (${SPENDING_KINDS.map(() => "?").join(", ")}) GROUP BY l.merchant_key ORDER BY n DESC LIMIT 400`,
				)
				.bind(...SPENDING_KINDS)
				.all<Unsorted>()
		).results;
		const batch = rows.filter((r) => !ruled.has(r.merchant_key)).slice(0, SORT_BATCH);
		if (!batch.length) return;
		const answer = await askForCategories(t, fixed, batch);
		if (answer === "blocked") return;
		if (answer === "failed") {
			t.putLater("sort_failed_at", t.iso());
			t.count("sort_merchants_failed");
			return;
		}
		const byKey = new Map(batch.map((b) => [b.merchant_key, b]));
		const answered = answer.filter((a) => byKey.has(a.merchant_key));
		// A person (never on a card) gets no rule: the owner picks per line.
		const people = answered.filter((a) => a.is_person && !byKey.get(a.merchant_key)!.on_card).map((a) => a.merchant_key);
		const given = new Map(answered.filter((a) => fixed.includes(a.category)).map((a) => [a.merchant_key, a.category]));
		// A merchant the reader left out is not asked again and again: the owner's catch-all if he has
		// one ("Others" in the English starting list, 其他 in the Traditional Chinese one).
		const fallback = fixed.find((c) => ["others", "other", "其他"].includes(c.toLowerCase()));
		const rules = batch.flatMap((b) => {
			if (people.includes(b.merchant_key)) return [];
			const category = given.get(b.merchant_key) ?? fallback;
			return category ? [{ merchant_key: b.merchant_key, category }] : [];
		});
		if (!rules.length && !people.length) {
			t.putLater("sort_failed_at", t.iso());
			return;
		}
		const ok = await publishRules(t, (book) => addPeople(addModelRules(constrainToList(book, fixed), rules), people), `sorted ${rules.length} merchants into the owner's categories; ${people.length} payees are people`);
		if (ok) {
			t.count("merchants_sorted", rules.length);
			if (people.length) t.count("payees_are_people", people.length);
		}
	},
};

async function askForCategories(t: Tick, fixed: readonly string[], batch: readonly Unsorted[]): Promise<{ merchant_key: string; category: string; is_person: boolean }[] | "blocked" | "failed"> {
	const schema = z.object({
		rules: z.array(
			z.object({
				merchant_key: z.string().describe("exactly as given"),
				category: z.enum(fixed as [string, ...string[]]),
				is_person: z.boolean().describe("true when the payee is an individual person (a PayNow or bank transfer to someone's own name), false for any business, shop, company or organisation"),
			}),
		),
	});
	const list = batch.map((b) => `${b.merchant_key} | ${b.raw ?? b.name ?? ""} | ${b.country ?? "?"} | ${b.on_card ? "card" : "bank/PayNow"} | ${b.kind} | ${b.n}× | ${formatMoney(b.home_minor ?? 0, homeCurrency())} total`).join("\n");
	const user =
		`the owner's categories (use ONLY these, spelled exactly): ${fixed.join(", ")}.\n` +
		"Put every merchant below in the one category that fits it best. Give one rule per merchant, with merchant_key copied exactly. If none fits, use the closest general one. " +
		"Say is_person true when the payee is a private individual (a person's name, often paid by PayNow or transfer; 'PTE LTD', a shop or brand is never a person) — still give your best category.\n\n" +
		fence("merchants", `merchant_key | as printed | country | paid by | kind | times | SGD\n${list}`);
	// Subscription mode: the question is this set of merchants (their counts may
	// grow while it waits); a different set replaces an unanswered older one.
	const r = await readWith(t, "senior", "categorise", user, schema, 8000, { slot: `sort:${await sha256Hex(batch.map((b) => b.merchant_key).sort().join("\n"))}`, group: "categorise" });
	if (!r.ok) return r.why === "blocked" ? "blocked" : "failed";
	return r.data.rules;
}

/// Publish a change to the playbook's rules; one retry when another writer moved it first.
async function publishRules(t: Tick, change: (book: Playbook) => Playbook, reason: string): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		t.forgetHead();
		const head = await t.head();
		const pub = await publishPlaybook(t.db, change(head?.body ?? emptyPlaybook()), head?.version ?? null, "senior", reason, t.iso());
		t.forgetHead();
		if (pub.ok) return true;
		if (pub.reason !== "conflict") {
			t.count("sort_merchants_refused");
			return false;
		}
	}
	return false;
}

export const categorise: Step = {
	name: "categorise",
	async run(t) {
		await followLateNames(t);
		const head = await t.head();
		const fixed = tickCategories(t);
		const rules = (head?.body.category_rules ?? []).filter((r) => !fixed.length || r.by === "owner" || fixed.includes(r.category));
		if (!rules.length) return;
		const reads = rules.filter((r) => r.kind).length + Math.ceil(rules.filter((r) => !r.kind).length / 90);
		const n = Math.min(CATEGORISE_PER_TICK, Math.floor((t.db.remaining() - reads - 5) / 2));
		if (n <= 0 || !t.room(reads + 5)) return;
		const e = engineFor(t, head, "rules");
		const done = await applyCategoryRules(e, rules, n);
		if (done) t.count("lines_categorised", done);
		// The owner's merchant rules also move lines a model's rule put elsewhere.
		const owner = rules.filter((r) => r.by === "owner");
		const left = Math.min(CATEGORISE_PER_TICK - done, Math.floor((t.db.remaining() - Math.ceil(owner.length / 45) - 5) / 2));
		if (owner.length && left > 0) {
			const moved = await enforceOwnerRules({ ...e, actor: "owner" }, owner, left);
			if (moved) t.count("lines_recategorised", moved);
		}
	},
};
