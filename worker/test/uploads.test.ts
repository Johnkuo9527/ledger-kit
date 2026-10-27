/// Statement PDFs the owner uploads himself (Citi emails none). Made-up
/// PDFs (test/fixtures, made by make-pdfs.py), a made-up Claude, no Gmail.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { needsOk } from "../../src/queries";
import { handleRequest, type App } from "../src/app";
import type { LedgerEnv } from "../src/env";
import { workQueue } from "../src/pipeline";
import { runTick } from "../src/tick";
import { cleanFilename, fromBase64, looksLikePdf, toBase64, UPLOAD_MAX_FILE_BYTES } from "../src/uploads";
import { FakeClaude, MODELS } from "./helpers/fake-claude";
import { BASE, CTX, exactCountingDb, get, json, makeDeps, makeEnv, post, signedIn, TEST_ASSETS } from "./helpers/harness";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const PLAIN = fixture("statement-plain.pdf"); // not locked, as Citi's downloads are
const LOCKED = fixture("statement-aes-256.pdf");
const SCANNED = fixture("slip-scanned-aes-256.pdf");
const PW = "made-up-pw-1234";
const NOT_PDF = new TextEncoder().encode("Dear the owner, this is not a statement.");

const CITI = (last4 = "3333", period_end = "2026-10-15") => ({
	institution: "citi",
	statements: [
		{
			last4,
			period_start: "2026-09-16",
			period_end,
			currency: "SGD",
			opening_balance: "100.00",
			opening_is_credit: false,
			closing_balance: "12.00",
			closing_is_credit: false,
			minimum_due: "50.00",
			due_date: "2026-11-05",
			payments_credited: "100.00",
			lines: [
				{ seq: 1, date: "2026-09-20", post_date: null, description: "BAKERY", currency: "SGD", amount: "12.00", bill_currency: null, bill_amount: null, direction: "out", country: "SG", kind_hint: "purchase", card_last4: null },
				{ seq: 2, date: "2026-09-25", post_date: null, description: "PAYMENT - THANK YOU", currency: "SGD", amount: "100.00", bill_currency: null, bill_amount: null, direction: "in", country: null, kind_hint: "payment", card_last4: null },
			],
		},
	],
	confidence: "sure",
	note: "",
});

let db: TestDb;
let env: LedgerEnv;
let D: ReturnType<typeof makeDeps>;
let app: App;
let cookie: string;

beforeEach(async () => {
	db = freshDb();
	await addAccounts(db);
	D = makeDeps();
	env = makeEnv(db, { ...MODELS });
	app = { assets: TEST_ASSETS, deps: D };
	cookie = await signedIn();
});
afterEach(() => db.close());

const send = (r: Request, e: LedgerEnv = env) => handleRequest(r, e, CTX, app);

function form(files: { name: string; bytes: Uint8Array }[], account?: string): FormData {
	const f = new FormData();
	for (const x of files) f.append("files", new Blob([x.bytes], { type: "application/pdf" }), x.name);
	if (account) f.append("account_id", account);
	return f;
}
const upload = (files: { name: string; bytes: Uint8Array }[], account?: string, c: string | undefined = cookie) =>
	send(new Request(`${BASE}/api/statements/upload`, { method: "POST", body: form(files, account), headers: c ? { Cookie: c } : {} }));
const share = (body: Uint8Array, headers: Record<string, string> = {}) =>
	send(new Request(`${BASE}/api/statements/share`, { method: "POST", body, headers: { Authorization: `Bearer ${env.LEDGER_SHORTCUT_KEY}`, "Content-Type": "application/pdf", ...headers } }));
/// Reading an upload is catching up: paid from the owner's own approval (LEDGER_CATCHUP_APPROVED_USD), never the daily cap.
const tick = (claude: FakeClaude, extra: Record<string, string> = {}) => runTick(makeEnv(db, { ...MODELS, LEDGER_CATCHUP_APPROVED_USD: "10", ...extra }), D, { claude }, [workQueue]);

const rows = (sql: string) => db.raw.prepare(sql).all() as Record<string, unknown>[];
const chunks = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM upload_chunks").get() as { n: number }).n;
const uploads = async () => (await json(await send(get("/api/statements/uploads", cookie)))).uploads as { id: string; filename: string; state: string; message: string; statements: { account: string; status: string }[] }[];

describe("bytes", () => {
	it("knows a PDF by its first bytes, round-trips base64, cleans a filename", () => {
		expect(looksLikePdf(PLAIN)).toBe(true);
		expect(looksLikePdf(NOT_PDF)).toBe(false);
		const big = new Uint8Array(70_000).map((_, i) => i % 251);
		expect(fromBase64(toBase64(big))).toEqual(big);
		expect(cleanFilename("../../etc/Citi\u202e Oct.pdf", "x.pdf")).toBe("Citi Oct.pdf");
		expect(cleanFilename("", "x.pdf")).toBe("x.pdf");
	});
});

describe("POST /api/statements/upload (the page)", () => {
	it("an unlocked Citi PDF: queued, read in the cron with no Gmail, imported, the file deleted; the card now has statements", async () => {
		db.raw.prepare("UPDATE accounts SET has_statements = 0 WHERE id = 'card-c'").run(); // as the owner's Citi card is seeded
		const res = await upload([{ name: "Citi Oct.pdf", bytes: PLAIN }]);
		expect(res.status).toBe(200);
		const b = await json(res);
		expect(b).toMatchObject({ ok: true, queued: 1, files: [{ filename: "Citi Oct.pdf", status: "queued" }] });
		expect(rows("SELECT source, kind, stage FROM work")).toEqual([{ source: "owner_upload", kind: "statement", stage: "new" }]);
		expect(chunks()).toBe(1);
		expect((await uploads())[0]).toMatchObject({ state: "queued" });

		const claude = new FakeClaude(() => CITI());
		const r = await tick(claude); // no Gmail service at all
		expect(r.errors).toEqual([]);
		expect(claude.calls).toHaveLength(1);
		expect(claude.calls[0]!.user).toContain("the owner uploaded himself");
		expect(claude.calls[0]!.user).toMatch(/<statement-[0-9a-f]{24}>/); // its text still fenced, as an email's
		expect(rows("SELECT account_id, period_end, minimum_due_minor, due_date FROM statements")).toEqual([{ account_id: "card-c", period_end: "2026-10-15", minimum_due_minor: 5000, due_date: "2026-11-05" }]);
		expect(rows("SELECT stage FROM work")).toEqual([{ stage: "done" }]);
		expect(chunks()).toBe(0); // never kept after the reading
		expect(rows("SELECT has_statements FROM accounts WHERE id = 'card-c'")).toEqual([{ has_statements: 1 }]);
		const list = await uploads();
		expect(list[0]).toMatchObject({ state: "imported", statements: [{ account: "card-c", status: "imported" }] });
		expect(list[0]!.message).toContain("已匯入");
		// 繳款 shows its bill like any other card's.
		const pay = await json(await send(get("/api/payments", cookie)));
		expect((pay.cards as { account: { id: string }; last_statement: unknown }[]).find((c) => c.account.id === "card-c")?.last_statement).toBeTruthy();
	});

	it("a locked one opens with the bank's password, found without being told the bank", async () => {
		await upload([{ name: "e-statement.pdf", bytes: LOCKED }]);
		const claude = new FakeClaude(() => CITI());
		await tick(claude, { LEDGER_PDF_PW_CITI: PW });
		expect(claude.calls).toHaveLength(1);
		expect(rows("SELECT account_id FROM statements")).toEqual([{ account_id: "card-c" }]);
		expect(chunks()).toBe(0);
	});

	it("duplicates: the same file twice is one upload; the same statement in another file is imported once", async () => {
		await upload([{ name: "a.pdf", bytes: PLAIN }]);
		const again = await json(await upload([{ name: "a copy.pdf", bytes: PLAIN }]));
		expect(again).toMatchObject({ queued: 0, files: [{ status: "duplicate" }] });
		const both = await json(await upload([{ name: "x.pdf", bytes: LOCKED }, { name: "x again.pdf", bytes: LOCKED }]));
		expect((both.files as { status: string }[]).map((f) => f.status)).toEqual(["queued", "duplicate"]);
		expect(rows("SELECT COUNT(*) AS n FROM work")).toEqual([{ n: 2 }]);
		const claude = new FakeClaude(() => CITI()); // both files hold the same October bill
		await tick(claude, { LEDGER_PDF_PW_CITI: PW });
		expect(claude.calls).toHaveLength(2);
		expect(rows("SELECT COUNT(*) AS n FROM statements")).toEqual([{ n: 1 }]);
		expect(rows("SELECT COUNT(*) AS n FROM lines WHERE statement_id IS NOT NULL")).toEqual([{ n: 2 }]);
		const states = (await uploads()).map((u) => u.state).sort();
		expect(states).toEqual(["duplicate", "imported"]);
	});

	it("refuses an oversize file, a non-PDF and an empty one — each said plainly; the good one beside them is taken", async () => {
		const huge = new Uint8Array(UPLOAD_MAX_FILE_BYTES + 1);
		huge.set(new TextEncoder().encode("%PDF-1.7"));
		const b = await json(await upload([{ name: "big.pdf", bytes: huge }, { name: "letter.pdf", bytes: NOT_PDF }, { name: "empty.pdf", bytes: new Uint8Array() }, { name: "ok.pdf", bytes: PLAIN }]));
		expect(b.files).toMatchObject([
			{ status: "refused", message: expect.stringContaining("10 MB") },
			{ status: "refused", message: expect.stringContaining("不是 PDF") },
			{ status: "refused", message: expect.stringContaining("空") },
			{ status: "queued" },
		]);
		expect(rows("SELECT COUNT(*) AS n FROM uploads")).toEqual([{ n: 1 }]);
	});

	it("refuses more than 30 files, no files, a body that is not multipart, an unknown card, and no session", async () => {
		const many = Array.from({ length: 31 }, (_, i) => ({ name: `${i}.pdf`, bytes: PLAIN }));
		expect((await upload(many)).status).toBe(400);
		expect((await send(new Request(`${BASE}/api/statements/upload`, { method: "POST", body: new FormData(), headers: { Cookie: cookie } }))).status).toBe(400);
		expect((await send(post("/api/statements/upload", {}, cookie))).status).toBe(400);
		expect((await upload([{ name: "a.pdf", bytes: PLAIN }], "no-such-card")).status).toBe(400);
		expect((await upload([{ name: "a.pdf", bytes: PLAIN }], "cash")).status).toBe(400); // cash has no statements
		expect((await upload([{ name: "a.pdf", bytes: PLAIN }], undefined, "")).status).toBe(401); // no session
		// The Shortcut's key does not open the page's upload.
		expect((await send(new Request(`${BASE}/api/statements/upload`, { method: "POST", body: form([{ name: "a.pdf", bytes: PLAIN }]), headers: { Authorization: `Bearer ${env.LEDGER_SHORTCUT_KEY}` } }))).status).toBe(401);
		expect(rows("SELECT COUNT(*) AS n FROM uploads")).toEqual([{ n: 0 }]);
	});

	it("30 statements in one request stay far inside the page's D1 limit", async () => {
		const counting = exactCountingDb(db);
		const e = makeEnv(counting.db);
		const files = Array.from({ length: 30 }, (_, i) => {
			const bytes = new Uint8Array(PLAIN.length + 8);
			bytes.set(PLAIN);
			bytes.set(new TextEncoder().encode(`%${String(i).padStart(6, "0")}`), PLAIN.length); // 30 different files
			return { name: `${i}.pdf`, bytes };
		});
		const res = await handleRequest(new Request(`${BASE}/api/statements/upload`, { method: "POST", body: form(files), headers: { Cookie: cookie } }), e, CTX, app);
		expect((await json(res)).queued).toBe(30);
		expect(counting.queries()).toBeLessThan(200); // D1 allows 1000
	});
});

describe("待確認: a card the ledger does not know, a lock nothing opens, a file that cannot be read", () => {
	it("the card on it matches no account: the owner picks the card, it is read again for that card", async () => {
		await upload([{ name: "card.pdf", bytes: PLAIN }]);
		await tick(new FakeClaude(() => CITI("9999")));
		expect(rows("SELECT stage, error FROM work")).toEqual([{ stage: "waiting", error: "pick account" }]);
		expect(chunks()).toBe(1); // kept until the owner answers (14 days at most)
		expect(rows("SELECT COUNT(*) AS n FROM escalations")).toEqual([{ n: 0 }]);
		const ok = await needsOk(db);
		expect(ok.uploads).toHaveLength(1);
		const item = ok.uploads[0]!;
		expect(item).toMatchObject({ state: "needs_account", filename: "card.pdf" });
		expect(item.detail).toContain("9999");
		const pick = item.actions.find((a) => a.id === "account")!;
		expect(pick.choices!.map((c) => c.value)).toContain("card-c");
		expect(ok.count).toBeGreaterThanOrEqual(1);
		const res = await send(post(pick.path, { ...pick.body, [pick.choice_key!]: "card-c" }, cookie));
		expect(res.status).toBe(200);
		const claude = new FakeClaude(() => CITI("9999")); // the PDF still prints another number
		await tick(claude);
		expect(rows("SELECT account_id FROM statements")).toEqual([{ account_id: "card-c" }]);
		expect((await needsOk(db)).uploads).toEqual([]);
		expect(chunks()).toBe(0);
	});

	it("locked, and no password the ledger has opens it: no bank's alarm (the bank is unknown); the owner picks the card and is told which secret", async () => {
		await upload([{ name: "locked.pdf", bytes: LOCKED }]);
		const claude = new FakeClaude(() => CITI());
		await tick(claude);
		expect(claude.calls).toHaveLength(0);
		expect(rows("SELECT stage, error FROM work")).toEqual([{ stage: "waiting", error: "pdf password" }]);
		expect(rows("SELECT key FROM alarms WHERE cleared_at IS NULL")).toEqual([]);
		const item = (await needsOk(db)).uploads[0]!;
		expect(item.state).toBe("needs_password");
		await send(post(`/api/statements/uploads/${item.id}/account`, { account_id: "card-c" }, cookie));
		await tick(claude);
		expect(rows("SELECT key FROM alarms WHERE cleared_at IS NULL")).toEqual([{ key: "pdf_password:CITI" }]);
		// The warning names the file the owner uploaded, and the card he said it is (14 Oct 2026).
		expect(rows("SELECT message FROM alarms WHERE cleared_at IS NULL")).toEqual([{ message: "你上傳的 card-c 帳單「locked.pdf」打不開（還沒設定密碼）。修法：npx wrangler secret put LEDGER_PDF_PW_CITI 設定密碼。帳單會等著，每天再試一次。" }]);
		await tick(claude); // waits a day, as an email's statement does
		expect(claude.calls).toHaveLength(0);
		D.advance(25 * 3_600_000);
		await tick(claude, { LEDGER_PDF_PW_CITI: PW });
		expect(rows("SELECT account_id FROM statements")).toEqual([{ account_id: "card-c" }]);
		expect(rows("SELECT key FROM alarms WHERE cleared_at IS NULL")).toEqual([]);
	});

	it("a scanned page (no text) fails at once in plain words, the file deleted; 知道了 takes it off the list", async () => {
		await upload([{ name: "scan.pdf", bytes: SCANNED }]);
		await tick(new FakeClaude(() => new Error("no model may read it")), { LEDGER_PDF_PW_CITI: PW });
		expect(rows("SELECT stage FROM work")).toEqual([{ stage: "failed" }]);
		expect(chunks()).toBe(0);
		expect(rows("SELECT COUNT(*) AS n FROM escalations")).toEqual([{ n: 0 }]); // the owner's to see, not the model's
		const item = (await needsOk(db)).uploads[0]!;
		expect(item).toMatchObject({ state: "failed" });
		expect(item.detail).toContain("沒有文字");
		expect((await uploads())[0]).toMatchObject({ state: "failed" });
		await send(post(item.actions[0]!.path, {}, cookie));
		expect((await needsOk(db)).uploads).toEqual([]);
		// It failed, so the same file may be sent again.
		expect(await json(await upload([{ name: "scan.pdf", bytes: SCANNED }]))).toMatchObject({ queued: 1 });
	});

	it("a file nobody answers for is deleted after 14 days", async () => {
		await upload([{ name: "card.pdf", bytes: PLAIN }]);
		await tick(new FakeClaude(() => CITI("9999")));
		expect(chunks()).toBe(1);
		D.advance(14 * 24 * 3_600_000); // exactly its 14 days: deleted, not read again
		const claude = new FakeClaude(() => new Error("not read again"));
		await tick(claude);
		await tick(claude);
		expect(claude.calls).toHaveLength(0);
		expect(chunks()).toBe(0);
		expect(rows("SELECT stage FROM work")).toEqual([{ stage: "failed" }]);
		expect((await uploads())[0]!.message).toContain("14 天");
	});
});

describe("POST /api/statements/share (the iPhone Share Sheet)", () => {
	it("the right key and a PDF: one plain sentence for the notification, read like any upload", async () => {
		const res = await share(PLAIN);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/plain");
		expect(await res.text()).toBe("已收到，讀取中");
		expect(rows("SELECT via, filename FROM uploads")).toEqual([{ via: "share", filename: expect.stringMatching(/^iPhone 分享 2026-10-\d\d \d\d:\d\d\.pdf$/) }]);
		expect(await (await share(PLAIN)).text()).toBe("這份帳單之前已經收過了");
		await tick(new FakeClaude(() => CITI()));
		expect(rows("SELECT account_id FROM statements")).toEqual([{ account_id: "card-c" }]);
	});

	it("takes a filename the Shortcut sends, and multipart too", async () => {
		await share(PLAIN, { "X-Filename": encodeURIComponent("Citi 十月.pdf") });
		expect(rows("SELECT filename FROM uploads")).toEqual([{ filename: "Citi 十月.pdf" }]);
		const f = form([{ name: "two.pdf", bytes: LOCKED }]);
		const res = await send(new Request(`${BASE}/api/statements/share`, { method: "POST", body: f, headers: { Authorization: `Bearer ${env.LEDGER_SHORTCUT_KEY}` } }));
		expect(await res.text()).toBe("已收到，讀取中");
	});

	it("refuses a wrong or missing key before reading anything, a non-PDF, and an oversize body", async () => {
		const wrong = await send(new Request(`${BASE}/api/statements/share`, { method: "POST", body: PLAIN, headers: { Authorization: "Bearer not-the-key-not-the-key-not-the-key-0000" } }));
		expect(wrong.status).toBe(401);
		expect(await wrong.text()).toContain("沒有授權");
		expect((await send(new Request(`${BASE}/api/statements/share`, { method: "POST", body: PLAIN }))).status).toBe(401);
		// The page's cookie is not the Shortcut's key.
		expect((await send(new Request(`${BASE}/api/statements/share`, { method: "POST", body: PLAIN, headers: { Cookie: cookie } }))).status).toBe(401);
		const letter = await share(NOT_PDF);
		expect(letter.status).toBe(400);
		expect(await letter.text()).toContain("不是 PDF");
		const big = await share(PLAIN, { "Content-Length": String(UPLOAD_MAX_FILE_BYTES + 1) });
		expect(big.status).toBe(413);
		expect((await send(new Request(`${BASE}/api/statements/share`, { headers: { Authorization: `Bearer ${env.LEDGER_SHORTCUT_KEY}` } }))).status).toBe(405);
		expect(rows("SELECT COUNT(*) AS n FROM uploads")).toEqual([{ n: 0 }]);
	});
});
