/// Every call the ledger makes to Claude goes through `ask()` here. It is paid
/// for by the owner's own API key (ANTHROPIC_API_KEY, his prepaid credit), never his
/// claude.ai subscription.
///
///   * Structured outputs: the answer must fit a strict schema (schemas.ts),
///     or it is not used.
///   * The playbook is the cached system prompt, so the daily model pays a
///     tenth of the price for it after the first call of the day.
///   * A hard spend cap per run: a call is not made unless its WORST case
///     (every input token at full price + every allowed output token) fits.
///   * Refusal, a cut-off answer, an answer that does not fit the schema, and
///     the API being down are each a named outcome, never a thrown crash.
///   * Credit exhausted (402 billing_error) stops the run cleanly and raises
///     the alarm the owner sees on his page and in the weekly email.
///
/// Model ids come from worker vars (LEDGER_MODEL_SENIOR / LEDGER_MODEL_DAILY,
/// wrangler.toml), never from code — CONTRACT.md §7. Prices below are the
/// published per-million-token rates (checked 2026-10-06) and are used only
/// to log and cap spend; an unknown model is costed at the dearest known rate.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type * as z from "zod/v4";

export interface Price {
	input: number; // US$ per million input tokens
	output: number;
	cache_write: number; // 5-minute cache write = 1.25 × input
	cache_read: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
	"claude-opus-5-5": { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
	"claude-sonnet-5-5": { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
};
const DEAREST: Price = { input: 4, output: 20, cache_write: 5, cache_read: 0.2 };

export function priceOf(model: string): Price {
	return PRICES[model] ?? DEAREST;
}

export interface Usage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
}

export function costUsd(model: string, u: Usage): number {
	const p = priceOf(model);
	return (u.input_tokens * p.input + (u.cache_creation_input_tokens ?? 0) * p.cache_write + (u.cache_read_input_tokens ?? 0) * p.cache_read + u.output_tokens * p.output) / 1e6;
}

/// A rough token count for text BEFORE sending it: about 3.5 characters per
/// token for English, about 1 per character for Chinese. Deliberately high,
/// because it feeds the spend cap and the dry run's estimate.
export function estimateTokens(text: string): number {
	let cjk = 0;
	for (const ch of text) if (/[　-鿿豈-﫿＀-￯]/u.test(ch)) cjk++;
	return Math.ceil((text.length - cjk) / 3.5 + cjk * 1.2);
}

/// What one run may spend, across every call it makes. Shared by reference.
export class SpendCap {
	spent = 0;
	calls = 0;
	readonly byModel: Record<string, { calls: number; usd: number; input: number; output: number; cache_read: number }> = {};
	/// Kept back from this call (US$): the part of the daily allowance reserved
	/// for reading new bank alerts, while anything else is asking (Tick.cap()).
	held = 0;
	constructor(readonly capUsd: number) {}
	worstCase(model: string, inputTokens: number, maxTokens: number): number {
		const p = priceOf(model);
		return (inputTokens * p.cache_write + maxTokens * p.output) / 1e6;
	}
	allows(usd: number): boolean {
		return this.spent + usd + this.held <= this.capUsd;
	}
	record(model: string, u: Usage): number {
		const usd = costUsd(model, u);
		this.spent += usd;
		this.calls++;
		const m = (this.byModel[model] ??= { calls: 0, usd: 0, input: 0, output: 0, cache_read: 0 });
		m.calls++;
		m.usd += usd;
		m.input += u.input_tokens + (u.cache_creation_input_tokens ?? 0);
		m.output += u.output_tokens;
		m.cache_read += u.cache_read_input_tokens ?? 0;
		return usd;
	}
}

export type Failure =
	| "refusal" // the model declined (stop_reason "refusal")
	| "cut_off" // hit max_tokens: the answer is incomplete, never used
	| "unfit" // did not match the schema
	| "over_cap" // this run's spend cap would be exceeded: not sent
	| "credit_exhausted" // 402 billing_error: the owner's API credit has run out
	| "key_rejected" // 401/403: the API key is wrong or revoked
	| "bad_request" // 400/404/413/422: our request was wrong — a bug, not a retry
	| "unavailable"; // 429/5xx/network, after the SDK's own retries

export type Answer<T> = { ok: true; data: T; model: string; usd: number; usage: Usage } | { ok: false; failure: Failure; message: string; model: string; usd: number };

/// Failures that end the whole run rather than just this one item.
export const STOPS_THE_RUN: ReadonlySet<Failure> = new Set(["credit_exhausted", "key_rejected", "over_cap"]);

/// The slice of the SDK client this file uses — the tests hand in a mock.
export interface ClaudeClient {
	messages: { parse: Anthropic["messages"]["parse"] };
}

export function makeClient(apiKey: string, fetchImpl?: typeof fetch): ClaudeClient {
	// The SDK retries 408/409/429/5xx and dropped connections itself, with
	// backoff; three tries is enough for a daily job that runs again tomorrow.
	return new Anthropic({ apiKey, maxRetries: 3, timeout: 10 * 60 * 1000, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

export interface Ask<S extends z.ZodType> {
	model: string;
	/// Stable instructions (+ the playbook): cached. Must be byte-identical between calls to hit.
	system: string;
	/// This item: an email, or a statement's text.
	user: string;
	schema: S;
	maxTokens: number;
	effort: "low" | "medium" | "high" | "xhigh" | "max";
	cap: SpendCap;
}

export async function ask<S extends z.ZodType>(client: ClaudeClient, a: Ask<S>): Promise<Answer<z.infer<S>>> {
	const worst = a.cap.worstCase(a.model, estimateTokens(a.system) + estimateTokens(a.user) + 600, a.maxTokens);
	if (!a.cap.allows(worst)) {
		return { ok: false, failure: "over_cap", message: `this run's spend cap (US$${a.cap.capUsd.toFixed(2)}${a.cap.held ? `, US$${a.cap.held.toFixed(2)} of it kept for bank alerts` : ""}) would be passed: US$${a.cap.spent.toFixed(4)} spent, this call could cost up to US$${worst.toFixed(4)}`, model: a.model, usd: 0 };
	}
	let res;
	try {
		res = await client.messages.parse({
			model: a.model,
			max_tokens: a.maxTokens,
			system: [{ type: "text", text: a.system, cache_control: { type: "ephemeral" } }],
			messages: [{ role: "user", content: a.user }],
			output_config: { effort: a.effort, format: zodOutputFormat(a.schema) },
		});
	} catch (e) {
		return { ...classifyError(e), model: a.model, usd: 0 };
	}
	const model = res.model || a.model;
	const usd = a.cap.record(model, res.usage);
	if (res.stop_reason === "refusal") {
		const why = res.stop_details?.category ? ` (${res.stop_details.category})` : "";
		return { ok: false, failure: "refusal", message: `the model declined${why}`, model, usd };
	}
	if (res.stop_reason === "max_tokens") return { ok: false, failure: "cut_off", message: `the answer was cut off at ${a.maxTokens} tokens`, model, usd };
	const parsed = a.schema.safeParse(res.parsed_output);
	if (res.parsed_output == null || !parsed.success) return { ok: false, failure: "unfit", message: "the answer did not fit the schema", model, usd };
	return { ok: true, data: parsed.data, model, usd, usage: res.usage };
}

export function classifyError(e: unknown): { ok: false; failure: Failure; message: string } {
	const fail = (failure: Failure, message: string) => ({ ok: false as const, failure, message });
	if (e instanceof Anthropic.APIError) {
		const status = e.status ?? 0;
		if (status === 402 || e.type === "billing_error") return fail("credit_exhausted", "the Anthropic API credit has run out — top it up at platform.claude.com → Billing");
		if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return fail("key_rejected", "the Anthropic API key was refused");
		if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError || status === 529 || status >= 500)
			return fail("unavailable", `the Claude API is not answering right now (${status || "no connection"})`);
		return fail("bad_request", `the Claude API refused the request (${status}): ${e.message.slice(0, 200)}`);
	}
	return fail("unavailable", `calling Claude failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
}
