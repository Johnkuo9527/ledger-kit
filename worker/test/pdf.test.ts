/// The hard part of the daily engine: a bank's password-protected statement PDF opened
/// INSIDE the worker. Every file here is made up (test/fixtures/make-pdfs.py);
/// each is encrypted a different way a bank might use. The same module was
/// also run in Cloudflare's own runtime (test/workerd/) — see README.md.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layoutLines, MAX_PDF_BYTES, readPdfText, unlockWithAny } from "../src/pdf";

const PW = "made-up-pw-1234";
const pdf = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/statement-${name}.pdf`, import.meta.url)));

describe("unlocking a statement", () => {
	it.each(["rc4-40", "rc4-128", "aes-128", "aes-256"])("%s opens with its password and reads line by line", async (name) => {
		const r = await readPdfText(pdf(name), PW);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.encrypted).toBe(true);
		expect(r.page_count).toBe(2);
		const lines = r.pages[0]!.split("\n");
		expect(lines).toContain("Statement Date: 15 Mar 2026");
		// A row stays one line: date, merchant and amount together, in order.
		expect(lines.find((l) => l.includes("KOPI CORNER"))).toMatch(/^02 MAR\s+KOPI CORNER SINGAPORE SG\s+4\.50$/);
		expect(lines.find((l) => l.includes("PAYMENT"))).toMatch(/100\.00 CR$/);
		expect(r.pages[1]).toContain("important notes");
	});

	it("reads a Traditional Chinese statement (台新-style), font embedded", async () => {
		const r = await readPdfText(pdf("zh-aes-256"), PW);
		expect(r.ok && r.pages[0]).toContain("2026/03/05 夜市小吃 350");
		expect(r.ok && r.pages[0]).toContain("本期應繳總額 2,550");
	});

	it("an unprotected PDF needs no password", async () => {
		const r = await readPdfText(pdf("plain"), null);
		expect(r.ok && r.encrypted).toBe(false);
	});

	it("a wrong password says so, and never throws", async () => {
		expect(await readPdfText(pdf("aes-256"), "not-it")).toMatchObject({ ok: false, reason: "wrong_password" });
		expect(await readPdfText(pdf("rc4-128"), "not-it")).toMatchObject({ ok: false, reason: "wrong_password" });
	});

	it("no password set, for a protected PDF, says so", async () => {
		expect(await readPdfText(pdf("aes-128"), null)).toMatchObject({ ok: false, reason: "needs_password" });
	});

	it("rubbish is unreadable, not a crash", async () => {
		expect(await readPdfText(new TextEncoder().encode("this is not a pdf"), PW)).toMatchObject({ ok: false, reason: "unreadable" });
	});

	it("an oversized attachment is refused before parsing", async () => {
		expect(await readPdfText(new Uint8Array(MAX_PDF_BYTES + 1), PW)).toMatchObject({ ok: false, reason: "too_large" });
	});

	it("tries the account's password, then the bank's", async () => {
		const r = await unlockWithAny(pdf("aes-256"), ["account-specific-wrong", PW]);
		expect(r.ok).toBe(true);
		expect(r.tried).toBe(2);
		expect(await unlockWithAny(pdf("aes-256"), ["a", "b"])).toMatchObject({ ok: false, reason: "wrong_password", tried: 2 });
	});

	it("the caller's bytes are left intact (PDF.js may take its copy)", async () => {
		const bytes = pdf("aes-256");
		const before = bytes.byteLength;
		await readPdfText(bytes, PW);
		expect(bytes.byteLength).toBe(before);
		expect((await readPdfText(bytes, PW)).ok).toBe(true);
	});
});

describe("laying text out as lines", () => {
	const item = (str: string, x: number, y: number, width = str.length * 5) => ({ str, transform: [1, 0, 0, 1, x, y], width });
	it("groups by baseline, top to bottom, left to right; wide gaps stay wide", () => {
		expect(layoutLines([item("4.50", 500, 700), item("02 MAR", 50, 700.5), item("Header", 50, 760), item("KOPI", 120, 700)])).toEqual(["Header", "02 MAR    KOPI    4.50"]);
	});
});
