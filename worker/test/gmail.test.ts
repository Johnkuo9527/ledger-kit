/// The Gmail client against a MOCK Gmail: no real Google call is ever made.
/// Every email here is made up.

import { describe, expect, it } from "vitest";
import { Gmail, GmailError, htmlToText, toMail, type GmailMessage } from "../src/gmail";

const b64url = (s: string | Uint8Array) => {
	const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const SECRETS = { GMAIL_CLIENT_ID: "made-up-id", GMAIL_CLIENT_SECRET: "made-up-secret", GMAIL_REFRESH_TOKEN: "made-up-refresh" };
const NOW = () => new Date("2026-10-09T02:00:00Z");

const ALERT: GmailMessage = {
	id: "m1",
	threadId: "t1",
	internalDate: String(Date.parse("2026-03-02T00:15:00Z")),
	payload: {
		mimeType: "multipart/alternative",
		headers: [
			{ name: "From", value: "Test Bank <alerts@testbank.example>" },
			{ name: "Subject", value: "Card transaction alert" },
		],
		parts: [
			{ mimeType: "text/plain", body: { data: b64url("Your card ending 1111 was charged SGD 4.50 at KOPI CORNER on 02 Mar 2026.") } },
			{ mimeType: "text/html", body: { data: b64url("<p>ignored when there is plain text</p>") } },
		],
	},
};
const STATEMENT: GmailMessage = {
	id: "m2",
	internalDate: "0",
	payload: {
		mimeType: "multipart/mixed",
		headers: [{ name: "from", value: "estatement@testbank.example" }],
		parts: [
			{ mimeType: "text/html", body: { data: b64url("<div>Your e-Statement is ready&nbsp;&amp; attached.</div><style>x{}</style>") } },
			{ mimeType: "application/octet-stream", filename: "Statement_Mar.PDF", body: { attachmentId: "att-1", size: 3375 } },
			{ mimeType: "image/png", filename: "logo.png", body: { attachmentId: "att-2", size: 10 } },
		],
	},
};

function google(handler: (url: string, init?: RequestInit) => Response) {
	const calls: string[] = [];
	const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		if (!url.startsWith("https://oauth2.googleapis.com/") && !url.startsWith("https://gmail.googleapis.com/")) throw new Error(`unexpected network call ${url}`);
		return handler(url, init);
	}) as typeof fetch;
	return { fetch, calls };
}
const tokenOk = () => Response.json({ access_token: "made-up-access", expires_in: 3600 });

describe("reading an email", () => {
	it("prefers the plain text, keeps the headers and the time it arrived", () => {
		const m = toMail(ALERT);
		expect(m).toMatchObject({ id: "m1", thread_id: "t1", from: "Test Bank <alerts@testbank.example>", subject: "Card transaction alert", received_at: "2026-03-02T00:15:00.000Z", pdfs: [] });
		expect(m.text).toContain("SGD 4.50 at KOPI CORNER");
		expect(m.text).not.toContain("ignored");
	});

	it("falls back to the HTML's text, and finds the PDF even when Gmail calls it octet-stream", () => {
		const m = toMail(STATEMENT);
		expect(m.text).toBe("Your e-Statement is ready & attached.");
		expect(m.pdfs).toEqual([{ filename: "Statement_Mar.PDF", attachment_id: "att-1", size: 3375 }]);
	});

	it("decodes a Big5 (Traditional Chinese) body by its charset", () => {
		const big5 = new Uint8Array([0xb4, 0xfa, 0xb8, 0xd5]); // 測試
		const m = toMail({ id: "m3", payload: { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="big5"' }], body: { data: b64url(big5) } } });
		expect(m.text).toBe("測試");
	});

	it("strips HTML tables into readable lines", () => {
		expect(htmlToText("<table><tr><td>Amount</td><td>SGD 4.50</td></tr><tr><td>To</td><td>KOPI</td></tr></table>")).toBe("Amount SGD 4.50\nTo KOPI");
	});
});

describe("talking to Gmail", () => {
	it("signs in once, lists a search, fetches a message and an attachment", async () => {
		const g = google((url) => {
			if (url.startsWith("https://oauth2")) return tokenOk();
			if (url.includes("/attachments/")) return Response.json({ data: b64url("%PDF-1.7 made up") });
			if (url.includes("/messages/m1")) return Response.json(ALERT);
			return Response.json({ messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "p2" });
		});
		const gmail = new Gmail(SECRETS, { fetch: g.fetch, now: NOW });
		expect(await gmail.list("from:testbank.example after:1700000000")).toEqual({ ids: ["m1", "m2"], next: "p2" });
		expect((await gmail.message("m1")).subject).toBe("Card transaction alert");
		expect(new TextDecoder().decode(await gmail.attachment("m2", "att-1"))).toBe("%PDF-1.7 made up");
		expect(g.calls.filter((u) => u.startsWith("https://oauth2"))).toHaveLength(1);
		expect(new URL(g.calls[1]!).searchParams.get("q")).toBe("from:testbank.example after:1700000000");
	});

	it("a revoked or expired sign-in is 'signin_failed' — the alarm, never a silent stop", async () => {
		const g = google(() => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
		await expect(new Gmail(SECRETS, { fetch: g.fetch, now: NOW }).list("x")).rejects.toMatchObject({ kind: "signin_failed" });
	});

	it("no secrets yet is 'not_set_up', and no call is made", async () => {
		const g = google(() => tokenOk());
		await expect(new Gmail({}, { fetch: g.fetch, now: NOW }).list("x")).rejects.toBeInstanceOf(GmailError);
		expect(g.calls).toHaveLength(0);
	});

	it("Gmail busy or down is 'unavailable' (try again next tick)", async () => {
		const g = google((url) => (url.startsWith("https://oauth2") ? tokenOk() : new Response("{}", { status: 503 })));
		await expect(new Gmail(SECRETS, { fetch: g.fetch, now: NOW }).list("x")).rejects.toMatchObject({ kind: "unavailable" });
	});
});
