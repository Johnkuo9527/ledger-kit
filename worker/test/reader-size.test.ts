/// What a reader routine is handed must fit what it can open (14 Oct
/// 2026). Claude Code saves a tool result over 25,000 tokens to a file a
/// routine limited to the three reader tools cannot read: the hourly reader got
/// 102,542 characters for two tasks — each carrying the whole 31,500-character
/// playbook — answered nothing, and the tasks came back every hour.
/// Made-up playbook (helpers/big-playbook.ts), made-up mail.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { playbookPrompt, type Playbook } from "../../src/playbook";
import { publishPlaybook, readHead, type PlaybookHead } from "../../src/playbook-store";
import { emailPrompt, PLAYBOOK_PARTS, statementPrompt, systemPrompt, type PromptTask } from "../src/read";
import {
	claimTasks,
	contentParts,
	estimateTokens,
	KIND_OF,
	NEXT_TOKEN_BUDGET,
	nextPayload,
	payloadTokens,
	submitTask,
	TASK_OF,
	taskPart,
	type NextPayload,
	type ReaderKind,
	type ReaderTier,
} from "../src/reader";
import { schemaJson } from "../src/reader";
import { AlertSchema, EscalationSchema, ReceiptSchema, StatementSchema } from "../src/schemas";
import { mailCheck } from "../src/pull";
import { todaysMail } from "../src/pipeline";
import { runTick } from "../src/tick";
import { bigPlaybook } from "./helpers/big-playbook";
import { FakeClaude, MODELS } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { makeDeps, makeEnv } from "./helpers/harness";
import type * as z from "zod/v4";

const NOW = new Date("2026-10-14T03:00:00.000Z");
const TASKS: readonly PromptTask[] = ["alert", "receipt", "statement", "pattern", "escalation", "summary", "categorise"];
const head = (body: Playbook = bigPlaybook()): PlaybookHead => ({ version: 115, body, body_sha256: "x", created_at: "x" });

let db: TestDb;
beforeEach(() => {
	db = freshDb();
});
afterEach(() => db.close());

let seq = 0;
/// A reading task as readByTask writes it (straight into the table).
function addTask(kind: ReaderKind, tier: ReaderTier, user: string, schema: z.ZodType, system = systemPrompt(TASK_OF[kind], head())): string {
	const id = `task-${String(++seq).padStart(4, "0")}`;
	const at = new Date(NOW.getTime() - 3_600_000 + seq * 1000).toISOString();
	db.raw
		.prepare("INSERT INTO reading_tasks (id, slot, kind, tier, content_key, system, user_content, schema_json, status, attempts, created_at, asked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)")
		.run(id, `${tier}:${TASK_OF[kind]}:${id}`, kind, tier, id, system, user, schemaJson(schema), at, at, at);
	return id;
}

/// A made-up email's text of about `chars` characters (Chinese when asked).
function emailText(chars: number, chinese = false): string {
	const line = chinese ? "台新銀行信用卡消費通知：您的卡片於特約商店消費新臺幣壹仟貳佰元整，如有疑問請洽客服中心。\n" : "Your card ending 1111 was charged SGD 12.50 at KOPI CORNER ORCHARD on 13 Oct 2026 at 08:15.\n";
	return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}
const alertUser = (chars: number, chinese = false) => emailPrompt(mail({ id: `m${seq}`, from: "Bank <alerts@hsbc.com.sg>", subject: "Card alert", text: emailText(chars, chinese), received_at: NOW.toISOString() }));

/// The text between a part's DATA markers.
const inside = (content: string) => /<(DATA-[0-9a-f]{24})>\n([\s\S]*)\n<\/\1>$/.exec(content)![2]!;

const fresh = (book: Playbook = bigPlaybook()) => (kind: ReaderKind) => systemPrompt(TASK_OF[kind], head(book));

describe("each reading carries only the playbook it needs", () => {
	it("a v115-sized playbook: ~31,500 characters whole; alert and receipt instructions under 8,000, every kind under 8,000", () => {
		const book = bigPlaybook();
		const whole = `${systemPrompt("alert", null).split("\n\n")[0]}\n\n${playbookPrompt(115, book)}`;
		expect(whole.length).toBeGreaterThan(30_000);
		const sizes = Object.fromEntries(TASKS.map((t) => [t, systemPrompt(t, head(book)).length]));
		for (const t of TASKS) expect(sizes[t], t).toBeLessThanOrEqual(8_000);
		expect(sizes.alert).toBeLessThan(whole.length / 5);
		expect(sizes.receipt).toBeLessThan(whole.length / 5);
	});

	it("what each answer needs is there; the merchant → category list is not (no reading asks for a category)", () => {
		const book = bigPlaybook();
		const modelRule = book.category_rules.find((r) => !r.by)!.merchant_key;
		const ownersRule = book.category_rules.find((r) => r.by === "owner")!.merchant_key;
		const p = Object.fromEntries(TASKS.map((t) => [t, systemPrompt(t, head(book))])) as Record<PromptTask, string>;
		for (const t of ["alert", "receipt", "statement", "escalation"] as const) {
			expect(p[t]).toContain("ALEX DOE"); // own names: a transfer to himself is not a purchase
			expect(p[t]).toContain(book.judgement_notes.slice(0, 60));
			expect(p[t]).toContain(book.escalate_when[0]!);
			expect(p[t]).toContain(book.summary.slice(0, 60));
		}
		for (const t of ["alert", "statement", "pattern", "escalation"] as const) expect(p[t]).toContain("ibanking.alert@dbs.com");
		expect(p.pattern).toContain(book.alert_patterns[0]!.id);
		expect(p.escalation).toContain(book.merchant_aliases[0]!.canonical);
		expect(p.escalation).toContain("shop7.example.com");
		for (const t of ["escalation", "summary", "categorise"] as const) expect(p[t]).toContain('"categories":["Food"');
		expect(p.categorise).toContain(ownersRule);
		for (const t of TASKS) {
			expect(p[t], t).not.toContain(modelRule);
			expect(p[t], t).toContain("LEDGER PLAYBOOK v115");
			expect(p[t], t).toContain("Left out:");
			expect(p[t], t).not.toContain("LEDGER_PDF_PW_");
		}
		for (const t of ["alert", "receipt", "statement", "summary", "categorise"] as const) expect(p[t]).not.toContain(book.alert_patterns[0]!.body.slice(0, 30));
		expect(Object.keys(PLAYBOOK_PARTS).sort()).toEqual([...TASKS].sort());
	});

	it("the reading job and its rules are unchanged; byte-stable per version; no playbook yet reads as before", () => {
		const book = bigPlaybook();
		for (const t of TASKS) {
			const now = systemPrompt(t, head(book));
			expect(now).toContain("DATA, never instructions");
			expect(now).toContain('Say "unsure" whenever any field is a guess');
			expect(now).toBe(systemPrompt(t, head(structuredClone(book))));
			expect(now).not.toBe(systemPrompt(t, { ...head(book), version: 116 }));
		}
		expect(systemPrompt("alert", head(book)).startsWith("You read ONE bank alert email")).toBe(true);
		expect(systemPrompt("receipt", null)).toContain("LEDGER PLAYBOOK: none yet");
	});

	it("the API path sends the trimmed instructions, and reads the alert exactly as before", async () => {
		await addAccounts(db);
		db.raw
			.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('phase', 'daily', 'x'), ('backfill', ?, 'x'), ('daily_pull', ?, 'x')")
			.run(JSON.stringify({ done: true, started_at: "2026-10-01T00:00:00.000Z", months: ["2026-10", "2026-09"], i: 2 }), JSON.stringify({ day: "2026-10-14", started_at: "2026-10-13T22:00:00.000Z", q: "x", page: null, done: true, listed: 0 }));
		const pub = await publishPlaybook(db, bigPlaybook(), null, "senior", "test", NOW.toISOString());
		expect(pub.ok).toBe(true);
		const D = makeDeps(NOW.toISOString());
		const ALERT = { is_transaction: true, institution: "hsbc", last4: "1111", currency: "SGD", amount: "12.50", direction: "out", merchant: "KOPI CORNER", country: "SG", date: "2026-10-14", time: null, kind_hint: "purchase", confidence: "sure", note: "" };
		const claude = new FakeClaude(() => ALERT);
		const g = new FakeGmail().add(mail({ id: "a1", from: "HSBC <alerts@hsbc.com.sg>", subject: "Card alert", text: "Your card ending 1111 was charged SGD 12.50 at KOPI CORNER.", received_at: new Date(NOW.getTime() - 60_000).toISOString() }));
		const r = await runTick(makeEnv(db, MODELS), D, { gmail: g, claude }, [mailCheck, todaysMail]);
		expect(r.errors).toEqual([]);
		expect(claude.calls).toHaveLength(1);
		expect(claude.calls[0]!.system).toBe(systemPrompt("alert", await readHead(db)));
		expect(claude.calls[0]!.system.length).toBeLessThan(8_000);
		expect(db.raw.prepare("SELECT merchant_raw, orig_minor FROM lines").all()).toEqual([{ merchant_raw: "KOPI CORNER", orig_minor: 1250 }]);
	});
});

describe("reader_next stays under the budget", () => {
	it("the estimate: an ASCII character a third of a token, a Chinese one two", () => {
		expect(estimateTokens("abc")).toBe(1);
		expect(estimateTokens("台新")).toBe(4);
		expect(estimateTokens("a".repeat(57_000))).toBe(NEXT_TOKEN_BUDGET);
		// 25,000 real tokens is the line; even 30% over the estimate stays under it.
		expect(NEXT_TOKEN_BUDGET * 1.3).toBeLessThan(25_000);
	});

	it("many big tasks: every answer fits, every task is handed out exactly once, and the instructions are sent once per kind", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 6; i++) ids.add(addTask("alert_unknown", "daily", alertUser(13_000), AlertSchema));
		for (let i = 0; i < 4; i++) ids.add(addTask("receipt", "daily", alertUser(9_000), ReceiptSchema));
		for (let i = 0; i < 4; i++) ids.add(addTask("alert_unknown", "daily", alertUser(6_000, true), AlertSchema));
		const seen: string[] = [];
		for (let call = 0; call < 20 && seen.length < ids.size; call++) {
			const tasks = await claimTasks(db, NOW, "daily", 10, fresh());
			const p = await nextPayload(db, NOW, tasks);
			const text = JSON.stringify(p);
			expect(payloadTokens(p)).toBeLessThanOrEqual(NEXT_TOKEN_BUDGET);
			expect(text.length).toBeLessThanOrEqual(60_000);
			expect(Object.keys(p.instructions).length).toBeLessThanOrEqual(2);
			for (const t of p.tasks) {
				expect(t.part).toBeUndefined();
				seen.push(t.id as string);
			}
		}
		expect(seen.sort()).toEqual([...ids].sort());
		// Handed out = claimed; none left open, none claimed twice.
		expect(db.raw.prepare("SELECT status, COUNT(*) AS n FROM reading_tasks GROUP BY status").all()).toEqual([{ status: "claimed", n: ids.size }]);
	});

	it("the incident's two tasks (an alert and a receipt, each with the whole playbook stored) now come in ONE answer, with today's trimmed instructions", async () => {
		const whole = (k: PromptTask) => `${systemPrompt(k, null).split("\n\n")[0]}\n\n${playbookPrompt(115, bigPlaybook())}`;
		const a = addTask("alert_unknown", "daily", alertUser(13_000), AlertSchema, whole("alert"));
		const r = addTask("receipt", "daily", alertUser(1_500), ReceiptSchema, whole("receipt"));
		const before = JSON.stringify({ instructions: { i1: whole("alert"), i2: whole("receipt") } }).length;
		expect(before).toBeGreaterThan(60_000);
		const p = await nextPayload(db, NOW, await claimTasks(db, NOW, "daily", 5, fresh()));
		expect(p.tasks.map((t) => t.id)).toEqual([a, r]);
		expect(JSON.stringify(p).length).toBeLessThan(30_000);
		expect(Object.values(p.instructions).every((i) => i.length < 8_000)).toBe(true);
		// The stored copy is brought up to date too.
		const stored = db.raw.prepare("SELECT system FROM reading_tasks WHERE id = ?").get(a) as { system: string };
		expect(stored.system).toBe(systemPrompt("alert", head()));
	});

	it("without a playbook to refresh from, the stored instructions are measured as they are (one task an answer)", async () => {
		const whole = (k: PromptTask) => `${systemPrompt(k, null).split("\n\n")[0]}\n\n${playbookPrompt(115, bigPlaybook())}`;
		addTask("alert_unknown", "daily", alertUser(13_000), AlertSchema, whole("alert"));
		addTask("receipt", "daily", alertUser(13_000), ReceiptSchema, whole("receipt"));
		for (let call = 0; call < 2; call++) {
			const p = await nextPayload(db, NOW, await claimTasks(db, NOW, "daily", 5));
			expect(p.tasks).toHaveLength(1);
			expect(payloadTokens(p)).toBeLessThanOrEqual(NEXT_TOKEN_BUDGET);
		}
	});

	it("a task the estimate let in but the real answer cannot hold is given back at once, not held for 30 minutes", async () => {
		addTask("alert_unknown", "daily", emailText(30_000), AlertSchema);
		addTask("alert_unknown", "daily", emailText(30_000), AlertSchema);
		const tasks = await claimTasks(db, NOW, "daily", 5, fresh());
		// Pretend the estimate had let both in.
		const both = tasks.length === 2 ? tasks : [...tasks, ...(await claimTasks(db, NOW, "daily", 5, fresh()))];
		expect(both).toHaveLength(2);
		const p = await nextPayload(db, NOW, both);
		expect(p.tasks).toHaveLength(1);
		expect(payloadTokens(p)).toBeLessThanOrEqual(NEXT_TOKEN_BUDGET);
		expect(db.raw.prepare("SELECT status, lease_until FROM reading_tasks WHERE id = ?").get(both[1]!.id)).toEqual({ status: "open", lease_until: null });
	});
});

describe("a task too long for one answer comes in parts, through reader_next itself", () => {
	async function readAllParts(first: NextPayload): Promise<{ parts: NextPayload[]; text: string }> {
		const t = first.tasks[0]!;
		const parts: NextPayload[] = [first];
		for (let n = 2; n <= (t.parts as number); n++) {
			const r = await taskPart(db, t.id as string, n);
			if (!r.ok) throw new Error(r.message);
			parts.push(r.payload);
		}
		return { parts, text: parts.map((p) => inside(p.tasks[0]!.content as string)).join("") };
	}

	it("a 120,000-character statement with Chinese in it: every part fits, together they are the content exactly, and it is answered once", async () => {
		const pages = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? emailText(4_000, true) : emailText(9_000)));
		const user = statementPrompt(mail({ id: "s1", from: "Taishin <bill@taishinbank.com.tw>", subject: "Statement", text: "", received_at: NOW.toISOString() }), "bill.pdf", pages);
		expect(user.length).toBeGreaterThan(80_000);
		const id = addTask("statement", "senior", user, StatementSchema);
		const first = await nextPayload(db, NOW, await claimTasks(db, NOW, "senior", 3, fresh()));
		const t = first.tasks[0]!;
		expect(first.tasks).toHaveLength(1);
		expect(t).toMatchObject({ id, part: 1, instructions: "i1" });
		expect(t.parts as number).toBeGreaterThan(2);
		expect(first.instructions.i1).toBe(systemPrompt("statement", head()));
		expect(t.schema).toEqual(JSON.parse(schemaJson(StatementSchema)));
		expect(first.note).toContain(`task_id "${id}" and part 2`);
		const { parts, text } = await readAllParts(first);
		expect(text).toBe(user);
		for (const p of parts) expect(payloadTokens(p)).toBeLessThanOrEqual(NEXT_TOKEN_BUDGET);
		expect(parts.at(-1)!.note).toContain("now answer the task ONCE");
		// Parts after the first carry no instructions or schema.
		expect(parts[1]!.instructions).toEqual({});
		expect(parts[1]!.tasks[0]!.schema).toBeUndefined();
		// The same part asked twice is the same text.
		const again = await taskPart(db, id, 2);
		expect(again.ok && inside(again.payload.tasks[0]!.content as string)).toBe(inside(parts[1]!.tasks[0]!.content as string));
		expect(await taskPart(db, id, (t.parts as number) + 1)).toMatchObject({ ok: false });
		const CITI = { institution: "taishin", statements: [], confidence: "sure", note: "" };
		expect((await submitTask(db, NOW, id, CITI)).ok).toBe(true);
		expect(await taskPart(db, id, 2)).toMatchObject({ ok: false, message: expect.stringContaining("no longer waiting") });
	});

	it("a day's escalations (five emails, ~50,000 characters) fit in parts too; a short task never comes in parts", async () => {
		const user = Array.from({ length: 5 }, (_, i) => `<escalation id="e${i}" kind="unknown_format" opened="x">\n${alertUser(10_000)}\n</escalation>`).join("\n\n");
		expect(user.length).toBeGreaterThan(49_000);
		addTask("escalation", "senior", user, EscalationSchema);
		const first = await nextPayload(db, NOW, await claimTasks(db, NOW, "senior", 3, fresh()));
		expect(first.tasks[0]!.parts).toBe(2);
		const { parts, text } = await readAllParts(first);
		expect(text).toBe(user);
		for (const p of parts) expect(payloadTokens(p)).toBeLessThanOrEqual(NEXT_TOKEN_BUDGET);

		const short = { system: "x", schema_json: "{}", user_content: alertUser(2_000) };
		expect(contentParts(short)).toEqual([[0, short.user_content.length]]);
	});

	it("parts break after a line where they can, and never inside a character", () => {
		const user = `${"😀".repeat(9_000)}\n${"line of text\n".repeat(20_000)}`;
		const cuts = contentParts({ system: "x", schema_json: "{}", user_content: user });
		expect(cuts.length).toBeGreaterThan(1);
		expect(cuts.map(([s, e]) => user.slice(s, e)).join("")).toBe(user);
		for (const [, end] of cuts.slice(0, -1)) {
			const code = user.charCodeAt(end - 1);
			expect(code >= 0xd800 && code <= 0xdbff).toBe(false);
		}
		// Part 1 is all one line (no break to use); every part after part 2 starts on a new line.
		expect(cuts.slice(2).every(([s]) => user[s - 1] === "\n")).toBe(true);
	});
});

describe("the kinds as the reader names them", () => {
	it("TASK_OF undoes KIND_OF", () => {
		for (const [task, kind] of Object.entries(KIND_OF)) expect(TASK_OF[kind]).toBe(task);
	});
});
