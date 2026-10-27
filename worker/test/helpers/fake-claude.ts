/// A made-up Claude for the engine's tests: no network, no key. Each call is
/// answered by `reply(call)` — an object becomes the parsed answer, an Error
/// is thrown as the SDK would throw it.

import type { ClaudeClient } from "../../src/claude";

export interface Call {
	model: string;
	system: string;
	user: string;
	effort: string;
	max_tokens: number;
}

export const USAGE = { input_tokens: 1000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 };

export class FakeClaude implements ClaudeClient {
	calls: Call[] = [];
	constructor(public reply: (c: Call) => object | Error) {}
	messages = {
		parse: (async (params: { model: string; system: { text: string }[]; messages: { content: string }[]; output_config: { effort: string }; max_tokens: number }) => {
			const call: Call = { model: params.model, system: params.system[0]!.text, user: params.messages[0]!.content, effort: params.output_config.effort, max_tokens: params.max_tokens };
			this.calls.push(call);
			const r = this.reply(call);
			if (r instanceof Error) throw r;
			const { stop_reason, ...parsed } = r as { stop_reason?: string };
			return { model: params.model, stop_reason: stop_reason ?? "end_turn", stop_details: null, usage: USAGE, parsed_output: parsed };
		}) as unknown as ClaudeClient["messages"]["parse"],
	};
	task(c: Call): string {
		return c.system.split("\n")[0]!;
	}
}

export const MODELS = { LEDGER_MODEL_SENIOR: "claude-opus-5-5", LEDGER_MODEL_DAILY: "claude-sonnet-5-5" };
