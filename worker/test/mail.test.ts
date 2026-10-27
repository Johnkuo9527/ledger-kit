import { describe, expect, it } from "vitest";
import type { Deps, LedgerEnv } from "../src/env";
import { sendMail } from "../src/mail";

describe("sendMail", () => {
	it("lowercases the recipient (Resend's test sender refuses a capitalised owner address)", async () => {
		let body: { to: string[] } | null = null;
		const deps = {
			fetch: async (_url: string, init: RequestInit) => {
				body = JSON.parse(String(init.body));
				return new Response("{}", { status: 200 });
			},
		} as unknown as Deps;
		const env = { RESEND_API_KEY: "re_test" } as LedgerEnv;
		expect(await sendMail(env, deps, { to: " owner@example.com ", subject: "s", text: "t" })).toBe("sent");
		expect(body!.to).toEqual(["owner@example.com"]);
	});
});
