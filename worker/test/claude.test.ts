/// The Claude layer with a MOCK client: no real API call is ever made here.
/// Real SDK error objects are raised, so the credit / key / outage handling is
/// tested against what the SDK actually throws.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ask, classifyError, costUsd, estimateTokens, SpendCap, STOPS_THE_RUN, type ClaudeClient } from "../src/claude";
import { AlertSchema, type AlertAnswer } from "../src/schemas";

const ALERT: AlertAnswer = { is_transaction: true, institution: "hsbc", last4: "1111", currency: "SGD", amount: "4.50", direction: "out", merchant: "KOPI CORNER", country: "SG", date: "2026-03-02", time: "08:15", kind_hint: "purchase", confidence: "sure", note: "" };
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 };

function mock(reply: object | (() => never), seen: unknown[] = []): ClaudeClient {
	return {
		messages: {
			parse: (async (params: unknown) => {
				seen.push(params);
				if (typeof reply === "function") reply();
				return { model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_details: null, usage: USAGE, parsed_output: ALERT, ...reply };
			}) as never,
		},
	};
}
const base = (cap = new SpendCap(1)) => ({ model: "claude-sonnet-5-5", system: "PLAYBOOK v1 …", user: "Your card ending 1111 was charged SGD 4.50", schema: AlertSchema, maxTokens: 1000, effort: "low" as const, cap });

describe("asking Claude", () => {
	it("returns the parsed answer and what it cost", async () => {
		const seen: Record<string, unknown>[] = [];
		const r = await ask(mock({}, seen), base());
		expect(r.ok && r.data.amount).toBe("4.50");
		// 1000 × $2 + 3000 × $0.20 + 200 × $10, per million
		expect(r.usd).toBeCloseTo((2000 + 600 + 2000) / 1e6, 10);
		const p = seen[0]!;
		expect(p.system).toEqual([{ type: "text", text: "PLAYBOOK v1 …", cache_control: { type: "ephemeral" } }]);
		expect((p.output_config as { effort: string; format: { type: string } }).effort).toBe("low");
		expect((p.output_config as { format: { type: string } }).format.type).toBe("json_schema");
		expect(p.model).toBe("claude-sonnet-5-5");
	});

	it("a refusal, a cut-off answer and a misfit are named failures, and still costed", async () => {
		expect(await ask(mock({ stop_reason: "refusal", stop_details: { category: "cyber" } }), base())).toMatchObject({ ok: false, failure: "refusal", message: "the model declined (cyber)" });
		const cut = await ask(mock({ stop_reason: "max_tokens" }), base());
		expect(cut).toMatchObject({ ok: false, failure: "cut_off" });
		expect(cut.usd).toBeGreaterThan(0);
		expect(await ask(mock({ parsed_output: null }), base())).toMatchObject({ ok: false, failure: "unfit" });
		expect(await ask(mock({ parsed_output: { ...ALERT, direction: "sideways" } }), base())).toMatchObject({ ok: false, failure: "unfit" });
	});

	it("the spend cap stops a call BEFORE it is made, on its worst case", async () => {
		const seen: unknown[] = [];
		const cap = new SpendCap(0.01);
		cap.spent = 0.0095;
		const r = await ask(mock({}, seen), { ...base(cap), maxTokens: 1000 }); // worst case ≥ 1000 × $10/M = $0.01
		expect(r).toMatchObject({ ok: false, failure: "over_cap" });
		expect(seen).toHaveLength(0);
		expect(STOPS_THE_RUN.has("over_cap")).toBe(true);
	});

	it("adds every call to the run's total, per model", async () => {
		const cap = new SpendCap(1);
		await ask(mock({}), base(cap));
		await ask(mock({ model: "claude-opus-5-5" }), { ...base(cap), model: "claude-opus-5-5" });
		expect(cap.calls).toBe(2);
		expect(cap.byModel["claude-opus-5-5"]!.usd).toBeCloseTo(costUsd("claude-opus-5-5", USAGE), 10);
		expect(cap.spent).toBeCloseTo(costUsd("claude-sonnet-5-5", USAGE) + costUsd("claude-opus-5-5", USAGE), 10);
	});
});

describe("what the API's errors mean", () => {
	const err = (status: number, type: string) => Anthropic.APIError.generate(status, { type: "error", error: { type, message: "made up" } }, "made up", new Headers());
	it.each([
		[402, "billing_error", "credit_exhausted"],
		[401, "authentication_error", "key_rejected"],
		[403, "permission_error", "key_rejected"],
		[429, "rate_limit_error", "unavailable"],
		[529, "overloaded_error", "unavailable"],
		[500, "api_error", "unavailable"],
		[400, "invalid_request_error", "bad_request"],
	])("%i %s → %s", (status, type, failure) => {
		expect(classifyError(err(status, type)).failure).toBe(failure);
	});

	it("credit exhausted stops the run, and the call reports it without throwing", async () => {
		const r = await ask(mock(() => { throw err(402, "billing_error"); }), base());
		expect(r).toMatchObject({ ok: false, failure: "credit_exhausted", usd: 0 });
		expect(STOPS_THE_RUN.has("credit_exhausted")).toBe(true);
		expect(classifyError(new Anthropic.APIConnectionError({ message: "down" })).failure).toBe("unavailable");
	});
});

describe("estimating tokens before a call", () => {
	it("errs high, and counts Chinese per character", () => {
		expect(estimateTokens("x".repeat(350))).toBe(100);
		expect(estimateTokens("夜市小吃")).toBe(5);
	});
});
