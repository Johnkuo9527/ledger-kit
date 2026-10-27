/// How much one connector request may carry (26 Oct 2026, GHSA-46jr-4wx8-v453): the MCP SDK put no
/// limit on how many array elements and object members it validated in one call, so a single request
/// inside the 4 MiB body limit could run a worker out of memory. The SDK's fix (1.32) is two settings,
/// both off unless asked for: a cap on a call's elements and the transport's body limit. These tests pin
/// that both connectors ask for them, and that the caps still fit the largest honest call each one gets.
/// Made-up data only.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import type { Ctx, LedgerEnv } from "../src/env";
import { handleMcp, LEDGER_MCP_LIMITS } from "../src/mcp";
import { handleReaderMcp, READER_MCP_LIMITS } from "../src/reader-mcp";
import { BASE, makeDeps, makeEnv, OWNER, seedWorld } from "./helpers/harness";

let raw: TestDb;
let env: LedgerEnv;
const deps = makeDeps();
const ledgerCtx: Ctx = { waitUntil() {}, props: { email: OWNER } };
const readerCtx: Ctx = { waitUntil() {}, props: { email: OWNER, aud: "reader" } };

beforeEach(async () => {
	raw = freshDb();
	await seedWorld(raw);
	env = makeEnv(raw);
});
afterEach(() => raw.close());

const post = (path: string, body: string): Request =>
	new Request(`${BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
		body,
	});
const call = (name: string, args: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

type CallResult = { result?: { content: { text: string }[]; isError?: boolean }; error?: { code: number; message: string } };
async function ledgerCall(name: string, args: unknown): Promise<CallResult> {
	const res = await handleMcp(post("/mcp", call(name, args)), env, ledgerCtx, deps);
	expect(res.status).toBe(200);
	return (await res.json()) as CallResult;
}
async function readerCall(name: string, args: unknown): Promise<CallResult> {
	const res = await handleReaderMcp(post("/mcp-reader", call(name, args)), env, readerCtx, deps);
	expect(res.status).toBe(200);
	return (await res.json()) as CallResult;
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `line-${i}`);
const lineEvents = () => (raw.raw.prepare("SELECT COUNT(*) AS n FROM line_events").get() as { n: number }).n;

/// A made-up statement answer of `lines` lines, as a reader might hand it in as an object.
function statementAnswer(lines: number): Record<string, unknown> {
	const line = (i: number) => ({
		date: "2026-09-01",
		posting_date: null,
		description: `TEST SHOP ${i}`,
		currency: "SGD",
		amount: "1.00",
		bill_currency: null,
		bill_amount: null,
		direction: "out",
		country: null,
		kind_hint: "purchase",
		card_last4: null,
	});
	return {
		institution: "other",
		statements: [{ last4: "0000", period_start: "2026-09-01", period_end: "2026-09-30", currency: "SGD", lines: Array.from({ length: lines }, (_, i) => line(i)) }],
		confidence: "sure",
		note: "",
	};
}

describe("the Ledger connector (/mcp)", () => {
	it("refuses a call carrying more elements than its cap, before any tool runs", async () => {
		// The cap is 10,000. include_line_ids of 10,001 ids is 10,001 array elements, plus the
		// object's own 3 members (action, trip_id, include_line_ids) = 10,004 > 10,000.
		expect(LEDGER_MCP_LIMITS.maxToolInputElements).toBe(10_000);
		const before = lineEvents();
		const r = await ledgerCall("ledger_confirm_trip", { action: "edit", trip_id: "trip-p", include_line_ids: ids(10_001) });
		expect(r.result?.isError).toBe(true);
		expect(r.result?.content[0]!.text).toContain("more than the maximum of 10000 elements");
		expect(lineEvents()).toBe(before);
	});

	it("lets a call just under the cap reach the tool", async () => {
		// 9,990 ids + the 3 members = 9,993 ≤ 10,000: the cap lets it through and the tool itself
		// answers — refusing in its own words, since the ledger takes at most 500 line ids (idList).
		const r = await ledgerCall("ledger_confirm_trip", { action: "edit", trip_id: "trip-p", include_line_ids: ids(9_990) });
		expect(JSON.parse(r.result!.content[0]!.text)).toEqual({ ok: false, message: "include_line_ids lists more than 500 lines" });
	});

	it("answers 413 to a body over 1 MiB without reading it as a call", async () => {
		// 1 MiB = 1,048,576 bytes. A note of 1,048,576 ASCII letters alone is already over it.
		expect(LEDGER_MCP_LIMITS.maxRequestBodySize).toBe(1_048_576);
		const res = await handleMcp(post("/mcp", call("ledger_add_cash", { note: "x".repeat(1_048_576) })), env, ledgerCtx, deps);
		expect(res.status).toBe(413);
	});
});

describe("the Ledger Reader connector (/mcp-reader)", () => {
	it("takes a 1,000-line statement handed in as an object — far over the Ledger connector's cap", async () => {
		// Every array element and object member counts: the arguments' 2 members (task_id, result_json)
		// + the answer's 4 + statements' 1 element + that statement's 5 members + lines' 1,000 elements
		// + 1,000 lines × 11 members = 2 + 4 + 1 + 5 + 1,000 + 11,000 = 12,012 — over the Ledger
		// connector's 10,000, under the reader's 50,000.
		expect(READER_MCP_LIMITS.maxToolInputElements).toBe(50_000);
		const r = await readerCall("reader_submit", { task_id: "no-such-task", result_json: statementAnswer(1_000) });
		expect(JSON.parse(r.result!.content[0]!.text)).toEqual({ ok: false, message: "no such task" });
	});

	it("refuses an answer over its cap", async () => {
		// 4,200 lines: 2 + 4 + 1 + 5 + 4,200 + 4,200 × 11 = 50,412 — over 50,000.
		const r = await readerCall("reader_submit", { task_id: "no-such-task", result_json: statementAnswer(4_200) });
		expect(r.result?.isError).toBe(true);
		expect(r.result?.content[0]!.text).toContain("more than the maximum of 50000 elements");
	});

	it("its body limit fits the longest answer text reader_submit accepts, even fully escaped", async () => {
		// reader_submit takes result_json text up to 400,000 characters. Written as \uXXXX escapes
		// (6 bytes each) that is 2,400,000 bytes, + the envelope — under 4 MiB (4,194,304 bytes).
		expect(READER_MCP_LIMITS.maxRequestBodySize).toBe(4_194_304);
		const body = call("reader_submit", { task_id: "no-such-task", result_json: "帳".repeat(400_000) }).replaceAll("帳", "\\u5e33");
		expect(body.length).toBeGreaterThan(2_400_000);
		const res = await handleReaderMcp(post("/mcp-reader", body), env, readerCtx, deps);
		expect(res.status).toBe(200);
		const r = (await res.json()) as CallResult;
		expect(JSON.parse(r.result!.content[0]!.text)).toEqual({ ok: false, message: "no such task" });
	});
});
