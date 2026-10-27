/// The PDF-password warning names the exact bills (14 Oct 2026). The owner:
/// "Have the warning name the exact bill, for example 「2024年9月台新帳單打不開」."
/// It reflects the bills STILL locked, never the last event: a newer bill that
/// opens does not clear it; it goes when the locked bills open. Made-up mail,
/// a made-up PDF and password.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRow } from "../../src/db";
import { needsOk } from "../../src/queries";
import { WALLET } from "../../test/helpers/fixtures";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { lockedMessage, PDF_LOCKS_NET_MS, type LockedBill } from "../src/pdf-locks";
import { workQueue } from "../src/pipeline";
import { runTick, type Services } from "../src/tick";
import { MODELS } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { makeDeps, makeEnv } from "./helpers/harness";

const PDF = new Uint8Array(readFileSync(new URL("./fixtures/statement-aes-256.pdf", import.meta.url)));
const PW = "made-up-pw-1234";

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
beforeEach(async () => {
	db = freshDb();
	D = makeDeps("2026-10-14T02:00:00.000Z");
	await addAccounts(db);
	await insertRow(db, "accounts", WALLET).run();
});
afterEach(() => db.close());

// No reader at all: a bill that opens then waits for the reader — enough to see what the warning does.
const tick = (g: FakeGmail, env: Record<string, string> = {}) => runTick(makeEnv(db, { ...MODELS, ...env }), D, { gmail: g, claude: null } as Services, [workQueue]);
function queue(...ids: string[]) {
	for (const id of ids) db.raw.prepare("INSERT INTO work (gmail_id, source, stage, attempts, created_at, updated_at) VALUES (?, 'daily', 'new', 0, 'x', 'x')").run(id);
}
const open = () => db.raw.prepare("SELECT key, message FROM alarms WHERE cleared_at IS NULL ORDER BY key").all() as { key: string; message: string }[];
const workRow = (id: string) => db.raw.prepare("SELECT stage, error FROM work WHERE gmail_id = ?").get(id) as { stage: string; error: string | null };

function taishinBill(g: FakeGmail, id: string, received: string) {
	g.add(mail({ id, from: "台新 <estatement@taishinbank.com.tw>", subject: "信用卡帳單", received_at: received, pdfs: [{ filename: "bill.pdf", attachment_id: "att1", size: PDF.length }] }));
	g.attachments.set(`${id}/att1`, PDF);
}

const TWO = "有 2 期台新帳單打不開（還沒設定密碼）：2024年10月寄來的、2024年9月寄來的。修法：npx wrangler secret put LEDGER_PDF_PW_TAISHIN 設定密碼。帳單會等著，每天再試一次。";

describe("a 台新 bill that will not open", () => {
	it("one bill: the warning names its month and bank", async () => {
		const g = new FakeGmail();
		taishinBill(g, "sep", "2024-09-05T01:00:00.000Z");
		queue("sep");
		await tick(g);
		expect(open()).toEqual([{ key: "pdf_password:TAISHIN", message: "2024年9月寄來的台新帳單打不開（還沒設定密碼）。修法：npx wrangler secret put LEDGER_PDF_PW_TAISHIN 設定密碼。帳單會等著，每天再試一次。" }]);
	});

	it("two locked bills from different months → ONE warning naming both, newest first; a newer bill that opens leaves it; the old ones opening clear it", async () => {
		const g = new FakeGmail();
		taishinBill(g, "sep", "2024-09-05T01:00:00.000Z");
		taishinBill(g, "oct", "2024-10-05T01:00:00.000Z");
		queue("sep", "oct");
		await tick(g);
		expect(open()).toEqual([{ key: "pdf_password:TAISHIN", message: TWO }]);
		expect(workRow("sep")).toEqual({ stage: "waiting", error: "pdf password" });

		// A newer bill arrives and opens (the two old ones are not due for a day): the warning stays, word for word.
		taishinBill(g, "nov", "2024-11-05T01:00:00.000Z");
		queue("nov");
		await tick(g, { LEDGER_PDF_PW_TAISHIN: PW });
		expect(workRow("nov").error).toBeNull();
		expect(open()).toEqual([{ key: "pdf_password:TAISHIN", message: TWO }]);

		// A day later the two old bills are tried again with the password, and open: the warning goes.
		D.advance(24 * 3_600_000);
		await tick(g, { LEDGER_PDF_PW_TAISHIN: PW });
		expect([workRow("sep").error, workRow("oct").error]).toEqual([null, null]);
		expect(open()).toEqual([]);
	});

	it("only one of the two opens: the warning names the one still locked, with why it was locked when last tried", async () => {
		const g = new FakeGmail();
		taishinBill(g, "sep", "2024-09-05T01:00:00.000Z");
		taishinBill(g, "oct", "2024-10-05T01:00:00.000Z");
		queue("sep", "oct");
		await tick(g, { LEDGER_PDF_PW_TAISHIN: "a-wrong-one" });
		expect(open()[0]!.message).toContain("有 2 期台新帳單打不開（密碼不對）");
		// The right password is set and October is tried again at once; September waits for its day.
		db.raw.prepare("UPDATE work SET not_before = NULL WHERE gmail_id = 'oct'").run();
		await tick(g, { LEDGER_PDF_PW_TAISHIN: PW });
		expect(workRow("oct").error).toBeNull();
		expect(open()).toEqual([{ key: "pdf_password:TAISHIN", message: "2024年9月寄來的台新帳單打不開（密碼不對）。修法：npx wrangler secret put LEDGER_PDF_PW_TAISHIN 存正確的密碼；如果是銀行換密碼之前的舊帳單，舊密碼存在 npx wrangler secret put LEDGER_PDF_PW_CARD_T_2（兩個都會試）。帳單會等著，每天再試一次。" }]);
		// 待確認 → 密碼 names the bill and the command too.
		const item = (await needsOk(db)).pdf_passwords[0]!;
		expect(item.detail).toBe("2024年9月寄來的台新帳單打不開（密碼不對）。帳單在等，每天會再試一次。");
		expect(item.instructions).toContain("npx wrangler secret put LEDGER_PDF_PW_CARD_T_2");
	});

	it("a warning written before this change (or left behind by a skipped upload) is rewritten — or cleared — by the net", async () => {
		db.raw.prepare("INSERT INTO alarms (key, message, raised_at) VALUES ('pdf_password:HSBC', 'A HSBC statement PDF would not open: no password is set.', '2026-10-01T00:00:00.000Z')").run();
		const g = new FakeGmail();
		taishinBill(g, "sep", "2024-09-05T01:00:00.000Z");
		queue("sep");
		await tick(g); // the net runs first: no HSBC bill is locked, so its stale warning goes
		expect(open().map((a) => a.key)).toEqual(["pdf_password:TAISHIN"]);
		// Something else moves the locked row (the owner skips it): the net catches it within its interval.
		db.raw.prepare("UPDATE work SET stage = 'done', error = NULL WHERE gmail_id = 'sep'").run();
		await tick(g);
		expect(open().map((a) => a.key)).toEqual(["pdf_password:TAISHIN"]); // not yet: it looks every few hours
		D.advance(PDF_LOCKS_NET_MS);
		await tick(g);
		expect(open()).toEqual([]);
	});
});

describe("a GrabPay statement PDF that will not open", () => {
	function grabBill(g: FakeGmail, id: string, received: string) {
		g.add(mail({ id, from: "Grab <no-reply@grab.com>", subject: "Your GrabPay Wallet statement", received_at: received, text: "Your statement is attached.", pdfs: [{ filename: "statement.pdf", attachment_id: "att1", size: PDF.length }] }));
		g.attachments.set(`${id}/att1`, PDF);
	}

	it("two locked statements → one warning naming both; a newer one opening leaves it; the old ones opening clear it", async () => {
		const g = new FakeGmail();
		grabBill(g, "g-aug", "2026-08-02T01:00:00.000Z");
		grabBill(g, "g-sep", "2026-09-02T01:00:00.000Z");
		queue("g-aug", "g-sep");
		await tick(g); // sorted as receipts: they wait behind the bank's mail
		await tick(g);
		const grab = "有 2 期 Grab 帳單打不開（還沒設定密碼）：2026年9月寄來的（wallet-g）、2026年8月寄來的（wallet-g）。修法：npx wrangler secret put LEDGER_PDF_PW_GRAB 設定密碼。帳單會等著，每天再試一次。";
		expect(open()).toEqual([{ key: "pdf_password:GRAB", message: grab }]);
		grabBill(g, "g-oct", "2026-10-02T01:00:00.000Z");
		queue("g-oct");
		await tick(g, { LEDGER_PDF_PW_GRAB: PW });
		await tick(g, { LEDGER_PDF_PW_GRAB: PW });
		expect(workRow("g-oct").error).toBeNull();
		expect(open()).toEqual([{ key: "pdf_password:GRAB", message: grab }]);
		D.advance(24 * 3_600_000);
		await tick(g, { LEDGER_PDF_PW_GRAB: PW });
		expect(open()).toEqual([]);
	});
});

describe("the warning's words", () => {
	const bill = (i: number, over: Partial<LockedBill> = {}): LockedBill => ({ gmail_id: `m${i}`, institution: "hsbc", arrived: `2025-${String(12 - i).padStart(2, "0")}-03`, file: null, account_id: null, reason: "wrong_password", ...over });
	const names = (id: string) => ({ "card-a": "HSBC card 1111" })[id] ?? null;
	const fix = { secret: "LEDGER_PDF_PW_HSBC", older_secret: "LEDGER_PDF_PW_CARD_A_2" };

	it("a long list stops at five: 「還有 N 期」", () => {
		const msg = lockedMessage("hsbc", [0, 1, 2, 3, 4, 5, 6].map((i) => bill(i)), fix, names);
		expect(msg.startsWith("有 7 期 HSBC 帳單打不開（密碼不對）：2025年12月寄來的、2025年11月寄來的、2025年10月寄來的、2025年9月寄來的、2025年8月寄來的，還有 2 期。")).toBe(true);
	});

	it("the card when known; an upload by its file name; never a password, only the secret's name", () => {
		expect(lockedMessage("hsbc", [bill(3, { account_id: "card-a" })], fix, names)).toBe(
			"2025年9月寄來的 HSBC card 1111 帳單打不開（密碼不對）。修法：npx wrangler secret put LEDGER_PDF_PW_HSBC 存正確的密碼；如果是銀行換密碼之前的舊帳單，舊密碼存在 npx wrangler secret put LEDGER_PDF_PW_CARD_A_2（兩個都會試）。帳單會等著，每天再試一次。",
		);
		expect(lockedMessage("hsbc", [bill(1, { file: "hsbc-sep.pdf", account_id: "card-a", reason: "no_password" })], fix, names)).toBe(
			"你上傳的 HSBC card 1111 帳單「hsbc-sep.pdf」打不開（還沒設定密碼）。修法：npx wrangler secret put LEDGER_PDF_PW_HSBC 設定密碼。帳單會等著，每天再試一次。",
		);
		expect(lockedMessage("hsbc", [bill(1, { file: "hsbc-sep.pdf", account_id: "card-a" }), bill(2)], fix, names)).toContain("：你上傳的「hsbc-sep.pdf」（HSBC card 1111）、2025年10月寄來的。");
	});

	it("bills locked for different reasons say each one's own", () => {
		expect(lockedMessage("hsbc", [bill(1), bill(2, { reason: "no_password" })], fix, names)).toBe(
			"有 2 期 HSBC 帳單打不開：2025年11月寄來的（密碼不對）、2025年10月寄來的（還沒設定密碼）。修法：npx wrangler secret put LEDGER_PDF_PW_HSBC 存正確的密碼；如果是銀行換密碼之前的舊帳單，舊密碼存在 npx wrangler secret put LEDGER_PDF_PW_CARD_A_2（兩個都會試）。帳單會等著，每天再試一次。",
		);
	});
});
