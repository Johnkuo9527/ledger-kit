/// (14 Oct 2026): HSBC's card alerts reaching the ledger, bank noise
/// sorted out before any reader sees it, and the fixed-format DBS / Citi
/// alerts read by code. Made-up amounts, names and card numbers throughout.

import { EXAMPLE_BANKS as BANKS } from "./helpers/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { addAccounts } from "../../test/helpers/world";
import { builtInAlert, citiAlert, dbsAlert, hsbcAlert } from "../src/banks";
import { workQueue } from "../src/pipeline";
import { gmailQuery, senderDomains } from "../src/pull";
import { classify, noiseReason, unknownBankSender } from "../src/read";
import { runTick, type Services } from "../src/tick";
import { FakeClaude, MODELS } from "./helpers/fake-claude";
import { FakeGmail, mail } from "./helpers/fake-gmail";
import { makeDeps, makeEnv } from "./helpers/harness";

const RECEIVED = "2026-10-13";
const at = (subject: string, body: string) => ({ subject, body, received_date: RECEIVED });

// ------------------------------------------------------------ the samples

const HSBC_FROM = "HSBC Singapore Transaction Alerts (Credit Card) <alerts@notification.hsbc.com.hk>";
const HSBC_BODY = [
	"Dear Customer",
	"Please note that there was a transaction made on your HSBC credit card.",
	"Card Number XXXX-XXXX-XXXX-1111",
	"Transaction Date 10/OCT/2026",
	"Transaction Time 19:42",
	"Transaction Amount SGD 23.45",
	"Merchant Name SIMPLYGO BUS MRT",
	"If you did not make this transaction, please call us immediately.",
].join("\n");

const DBS_PAYNOW_UEN = [
	"Transaction Ref: 20261013123456",
	"Dear Sir / Madam,",
	"We refer to your PAYNOW dated 13 Oct 12:34 (SGT). We are pleased to confirm that the transaction was completed.",
	"Date & Time: 13 Oct 12:34 (SGT)",
	"Amount: SGD12.60",
	"From: DBS Multiplier Account A/C ending 9001",
	"To: KOPI CORNER PTE. LTD. (UEN ending 123A)",
	"To view transaction details, please log in to digibank.",
].join("\n");
const DBS_PAYNOW_PERSON = DBS_PAYNOW_UEN.replace("SGD12.60", "SGD40.00").replace("KOPI CORNER PTE. LTD. (UEN ending 123A)", "JANE TAN (Mobile ending 5678)");
const DBS_NETS = [
	"Dear Sir / Madam,",
	"We are pleased to confirm that your NETS QR payment was successful.",
	"Date & Time: 13 Oct 08:05 (SGT)",
	"Amount: S$2.10",
	"From: DBS/POSB Account ending 9001",
	"To: TOAST STALL 26",
].join("\n");
const DBS_INCOMING = [
	"Dear Sir / Madam,",
	"You have received a PayNow transfer.",
	"Date & Time: 13 Oct 21:10 (SGT)",
	"Amount: SGD18.00",
	"From: JANE TAN",
	"To: DBS Multiplier Account A/C ending 9001",
].join("\n");
const DBS_BILL = DBS_PAYNOW_UEN.replace("KOPI CORNER PTE. LTD. (UEN ending 123A)", "HSBC VISA (A/C ending 1111)");

const CITI_BODY = [
	"Citi Alerts - Credit Card/Ready Credit Transaction",
	"Account Number: XXXX-XXXX-XXXX-3333",
	"Transaction date: 13/10/26",
	"Transaction time: 16:00:48",
	"Transaction amount: SGD10.06",
	"Transaction details: Lazada SG SINGAPORE SGP",
].join("\n");

// ------------------------------------------------------------- unit tests

describe("built-in readers", () => {
	it("HSBC: the card alert the owner's phone shows, every field", () => {
		expect(hsbcAlert(at("HSBC Transaction Alert", HSBC_BODY))).toEqual({
			pattern_id: "builtin-hsbc",
			institution: "hsbc",
			kind_hint: "purchase",
			currency: "SGD",
			amount_minor: 2345,
			last4: "1111",
			merchant_raw: "SIMPLYGO BUS MRT",
			merchant_country: null,
			txn_date: "2026-10-10",
			txn_time: "19:42",
		});
		// All on one line (as a phone preview shows it), labels with colons.
		const flat = "Dear Customer Please note that there was a transaction made on your HSBC credit card. Card Number: XXXX-XXXX-XXXX-1111 Transaction Date: 10/OCT/2026 Transaction Amount: SGD 7.80 Merchant: BUS/MRT 123 Please call us if this was not you.";
		expect(hsbcAlert(at("x", flat))).toMatchObject({ last4: "1111", amount_minor: 780, merchant_raw: "BUS/MRT 123", txn_date: "2026-10-10" });
		// Anything missing: the reader reads it, nothing is guessed.
		expect(hsbcAlert(at("x", HSBC_BODY.replace("Transaction Amount SGD 23.45\n", "")))).toBeNull();
		expect(hsbcAlert(at("x", "Your HSBC statement is ready."))).toBeNull();
	});

	it("DBS PayNow to a business (UEN): a purchase at that business", () => {
		expect(dbsAlert(at("iBanking Alerts", DBS_PAYNOW_UEN))).toEqual({
			pattern_id: "builtin-dbs",
			institution: "dbs",
			kind_hint: "purchase",
			currency: "SGD",
			amount_minor: 1260,
			last4: "9001",
			merchant_raw: "KOPI CORNER PTE. LTD.",
			merchant_country: null,
			txn_date: "2026-10-13",
			txn_time: "12:34",
		});
	});

	it("DBS PayNow to a person: a transfer, named as printed (the owner's payee rules decide)", () => {
		expect(dbsAlert(at("iBanking Alerts", DBS_PAYNOW_PERSON))).toMatchObject({ kind_hint: "transfer", amount_minor: 4000, last4: "9001", merchant_raw: "JANE TAN (Mobile ending 5678)" });
	});

	it("DBS NETS Scan & Pay: a purchase, S$ read as SGD", () => {
		expect(dbsAlert(at("digibank Alert - Successful NETS Scan & Pay", DBS_NETS))).toMatchObject({ kind_hint: "purchase", currency: "SGD", amount_minor: 210, last4: "9001", merchant_raw: "TOAST STALL 26", txn_time: "08:05" });
	});

	it("DBS money in: income (money in is negative)", () => {
		expect(dbsAlert(at("iBanking Alerts", DBS_INCOMING))).toMatchObject({ kind_hint: "income", amount_minor: -1800, last4: "9001", merchant_raw: "JANE TAN" });
	});

	it("DBS paying another bank's card: a card bill (payment), the card's digits kept for the engine", () => {
		const body = DBS_PAYNOW_UEN.replace("SGD12.60", "SGD162.94").replace("KOPI CORNER PTE. LTD. (UEN ending 123A)", "Other bank's card ending 1111");
		expect(dbsAlert(at("iBanking Alerts", body))).toMatchObject({ kind_hint: "payment", amount_minor: 16_294, last4: "9001", merchant_raw: "Other bank's card ending 1111" });
	});

	it("DBS: a bill payment or transfer to an account number is left to the reader", () => {
		expect(dbsAlert(at("iBanking Alerts", DBS_BILL))).toBeNull();
		// …and so is the ATM alert (the playbook's own pattern reads that).
		expect(dbsAlert(at("DBS Alert", "There was a cash withdrawal of S$100.00 with your DBS/POSB card ending 9002 on 13 Oct at 10:00"))).toBeNull();
	});

	it("DBS: a date late in December read in January is last year's", () => {
		expect(dbsAlert({ subject: "iBanking Alerts", body: DBS_PAYNOW_UEN.replaceAll("13 Oct", "31 Dec"), received_date: "2027-01-01" })).toMatchObject({ txn_date: "2026-12-31" });
	});

	it("Citi: card, date, time, amount, merchant and its country", () => {
		expect(citiAlert(at("Citi Alerts - Credit Card/Ready Credit Transaction", CITI_BODY))).toEqual({
			pattern_id: "builtin-citi",
			institution: "citi",
			kind_hint: "purchase",
			currency: "SGD",
			amount_minor: 1006,
			last4: "3333",
			merchant_raw: "Lazada SG SINGAPORE",
			merchant_country: "SG",
			txn_date: "2026-10-13",
			txn_time: "16:00",
		});
		// A foreign charge in a whole-number currency.
		expect(citiAlert(at("x", CITI_BODY.replace("SGD10.06", "JPY1,200").replace("SINGAPORE SGP", "OSAKA JPN")))).toMatchObject({ currency: "JPY", amount_minor: 1200, merchant_country: "JP" });
		// A signed or credit amount is not guessed at.
		expect(citiAlert(at("x", CITI_BODY.replace("SGD10.06", "-SGD10.06")))).toBeNull();
		// As Citi really prints it: padded labels, two spaces in "Transaction  details", merchant then city.
		const padded = [
			"Account Number           : XXXX-XXXX-XXXX-3333",
			"Transaction date         : 14/10/26",
			"Transaction time         : 09:40:42",
			"Transaction amount       : SGD4.90",
			"Transaction  details     : paul-ofc-b1            Singapore     SGP",
		].join("\n");
		expect(citiAlert(at("x", padded))).toMatchObject({ last4: "3333", currency: "SGD", amount_minor: 490, merchant_country: "SG", txn_date: "2026-10-14", txn_time: "09:40" });
	});

	it("each reader only for its own bank", () => {
		expect(builtInAlert("citi", at("iBanking Alerts", DBS_PAYNOW_UEN))).toBeNull();
		expect(builtInAlert(null, at("x", CITI_BODY))).toBeNull();
		expect(builtInAlert("taishin", at("x", CITI_BODY))).toBeNull();
		expect(builtInAlert("citi", at("x", CITI_BODY))).not.toBeNull();
	});
});

// ------------------------------------------------------------------ noise

const m = (from: string, subject: string, pdf = false) => ({ from, subject, pdfs: pdf ? [{ filename: "s.pdf", attachment_id: "a", size: 1 }] : [] });

describe("bank noise is sorted out by rules", () => {
	it("adverts, newsletters, codes, sign-in notices and eDocument notices", () => {
		expect(noiseReason(m("Citibank <citibank@marketing.citibank.com.sg>", "<ADV> Enjoy 10% cashback on dining"), BANKS)).toBe("advert");
		expect(noiseReason(m("Citibank <citibank@marketing.citibank.com.sg>", "Your exclusive dining privileges"), BANKS)).toBe("marketing_sender");
		expect(noiseReason(m("HSBC <hsbc@hsbc.com.sg>", "Weekly Insights: markets this week"), BANKS)).toBe("newsletter");
		expect(noiseReason(m("台新銀行 <service@taishinbank.com.tw>", "雙11刷卡滿額禮 最高回饋10% ADV"), BANKS)).toBe("advert");
		expect(noiseReason(m("Richart <richart@taishinbank.com.tw>", "Richart Life 登入失敗通知"), BANKS)).toBe("notice");
		expect(noiseReason(m("DBS <ibanking.alert@dbs.com>", "Your eDocument(s) are ready"), BANKS)).toBe("notice");
		expect(noiseReason(m("DBS <ibanking.alert@dbs.com>", "One-Time Password for your transaction"), BANKS)).toBe("code");
		expect(noiseReason(m("Citi <alerts@citibank.com.sg>", "Your Citi eStatement is ready"), BANKS)).toBe("notice");
	});

	it("never a real transaction alert, a statement, or a shop's receipt", () => {
		expect(noiseReason(m("DBS <ibanking.alert@dbs.com>", "iBanking Alerts"), BANKS)).toBeNull();
		expect(noiseReason(m("DBS <paylah.alert@dbs.com>", "digibank Alert - Successful NETS Scan & Pay"), BANKS)).toBeNull();
		expect(noiseReason(m("Citi <alerts@citibank.com.sg>", "Citi Alerts - Credit Card/Ready Credit Transaction"), BANKS)).toBeNull();
		expect(noiseReason(m(HSBC_FROM, "HSBC Singapore Transaction Alert"), BANKS)).toBeNull();
		expect(noiseReason(m("DBS <ibanking.alert@dbs.com>", "Security alert: card transaction of SGD 120.00"), BANKS)).toBeNull();
		expect(noiseReason(m("HSBC <estatement@hsbc.com.sg>", "Your eStatement is ready - password protected", true), BANKS)).toBeNull();
		expect(noiseReason(m("Shop <news@shop.example>", "Your receipt"), BANKS)).toBeNull();
		expect(noiseReason(m("ADVANCE <hello@advance.example>", "Advance booking confirmation"), BANKS)).toBeNull();
	});

	it("a bank's noise is 'ignored', even when Gmail vouched for it", () => {
		const ad = mail({ id: "ad", from: "Citibank <citibank@marketing.citibank.com.sg>", subject: "<ADV> Enjoy 10% cashback" });
		expect(classify(ad, null, BANKS)).toBe("ignored");
		const real = mail({ id: "r", from: "Citi <alerts@citibank.com.sg>", subject: "Citi Alerts - Credit Card/Ready Credit Transaction", text: CITI_BODY });
		expect(classify(real, null, BANKS)).toBe("alert");
	});
});

// ------------------------------------------------------------ the HSBC miss

describe("HSBC card alerts reach the ledger", () => {
	it("the Gmail search finds HSBC by name and by its alert domain", () => {
		const q = gmailQuery(senderDomains(undefined, null, BANKS), BANKS.searchNames(), "Ledger <ledger@example.com>", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z"));
		expect(q).toContain("hsbc.com.hk");
		expect(q).toMatch(/from:\([^)]*\bhsbc\b[^)]*\)/);
	});

	it("an HSBC alert from HSBC's alert mailer is a verified HSBC alert", () => {
		const hk = mail({ id: "h", from: HSBC_FROM, subject: "HSBC Transaction Alert", text: HSBC_BODY });
		expect(hk.auth).toEqual(["notification.hsbc.com.hk"]);
		expect(classify(hk, null, BANKS)).toBe("alert");
	});

	it("a bank-named alert from an address of no bank: the owner is told the address", () => {
		const odd = mail({ id: "o", from: "HSBC Singapore Transaction Alerts (Credit Card) <alerts@hsbc-mailer.example>", subject: "Transaction Alert", text: HSBC_BODY });
		expect(classify(odd, null, BANKS)).toBe("receipt");
		expect(unknownBankSender(odd, null, BANKS)).toEqual({ bank: "hsbc", address: "alerts@hsbc-mailer.example" });
		// An ordinary shop is not a bank.
		expect(unknownBankSender(mail({ id: "s", from: "Shop <orders@shop.example>", subject: "Your receipt" }), null, BANKS)).toBeNull();
	});
});

// --------------------------------------------------- through the work queue

let db: TestDb;
let D: ReturnType<typeof makeDeps>;
beforeEach(async () => {
	db = freshDb();
	D = makeDeps();
	await addAccounts(db);
});
afterEach(() => db.close());

const SUB = { LEDGER_READER: "subscription" };
const tick = (svc: Services, env = {}) => runTick(makeEnv(db, { ...MODELS, ...env }), D, svc, [workQueue]);
function queue(...ids: string[]) {
	for (const id of ids) db.raw.prepare("INSERT INTO work (gmail_id, source, stage, attempts, created_at, updated_at) VALUES (?, 'daily', 'new', 0, 'x', 'x')").run(id);
}
const noClaude = () => new FakeClaude(() => new Error("a built-in reading needs no model"));
const tasks = () => db.raw.prepare("SELECT kind FROM reading_tasks").all();
const lines = () =>
	db.raw.prepare("SELECT account_id, kind, orig_minor AS amount_minor, merchant_raw FROM lines ORDER BY orig_minor").all() as { account_id: string; kind: string; amount_minor: number; merchant_raw: string }[];

describe("in the live (subscription) reading", () => {
	it("HSBC, DBS and Citi alerts become lines with no reading task; bank noise is ignored with none either", async () => {
		const at10 = "2026-10-13T05:00:00.000Z";
		const g = new FakeGmail().add(
			mail({ id: "hsbc", from: HSBC_FROM, subject: "HSBC Transaction Alert", text: HSBC_BODY, received_at: at10 }),
			mail({ id: "uen", from: "DBS <ibanking.alert@dbs.com>", subject: "iBanking Alerts", text: DBS_PAYNOW_UEN, received_at: at10 }),
			mail({ id: "nets", from: "DBS <paylah.alert@dbs.com>", subject: "digibank Alert - Successful NETS Scan & Pay", text: DBS_NETS, received_at: at10 }),
			mail({ id: "citi", from: "Citi <alerts@citibank.com.sg>", subject: "Citi Alerts - Credit Card/Ready Credit Transaction", text: CITI_BODY, received_at: at10 }),
			mail({ id: "ad", from: "Citibank <citibank@marketing.citibank.com.sg>", subject: "<ADV> Enjoy 10% cashback", text: "Spend S$500 and get S$50 back.", received_at: at10 }),
			mail({ id: "edoc", from: "DBS <ibanking.alert@dbs.com>", subject: "Your eDocument(s) are ready", text: "Log in to view.", received_at: at10 }),
		);
		const claude = noClaude();
		queue("hsbc", "uen", "nets", "citi", "ad", "edoc");
		await tick({ gmail: g, claude }, SUB);
		expect(claude.calls).toHaveLength(0);
		expect(tasks()).toEqual([]);
		expect(lines()).toEqual([
			{ account_id: "bank-x", kind: "purchase", amount_minor: 210, merchant_raw: "TOAST STALL 26" },
			{ account_id: "card-c", kind: "purchase", amount_minor: 1006, merchant_raw: "Lazada SG SINGAPORE" },
			{ account_id: "bank-x", kind: "purchase", amount_minor: 1260, merchant_raw: "KOPI CORNER PTE. LTD." },
			{ account_id: "card-a", kind: "purchase", amount_minor: 2345, merchant_raw: "SIMPLYGO BUS MRT" },
		]);
		const kinds = db.raw.prepare("SELECT gmail_id, classification FROM messages ORDER BY gmail_id").all();
		expect(kinds).toEqual([
			{ gmail_id: "ad", classification: "ignored" },
			{ gmail_id: "citi", classification: "alert" },
			{ gmail_id: "edoc", classification: "ignored" },
			{ gmail_id: "hsbc", classification: "alert" },
			{ gmail_id: "nets", classification: "alert" },
			{ gmail_id: "uen", classification: "alert" },
		]);
	});

	// A PayNow to a person is read as a transfer; the engine's own rule (transfers.ts)
	// makes money paid to someone else spending unless the owner's payee rule says otherwise.
	it("PayNow to a person goes through the transfer rules (spending by default), money in is income", async () => {
		const at10 = "2026-10-13T05:00:00.000Z";
		const g = new FakeGmail().add(
			mail({ id: "person", from: "DBS <ibanking.alert@dbs.com>", subject: "iBanking Alerts", text: DBS_PAYNOW_PERSON, received_at: at10 }),
			mail({ id: "in", from: "DBS <ibanking.alert@dbs.com>", subject: "iBanking Alerts", text: DBS_INCOMING, received_at: at10 }),
		);
		queue("person", "in");
		await tick({ gmail: g, claude: noClaude() }, SUB);
		expect(tasks()).toEqual([]);
		expect(lines()).toEqual([
			{ account_id: "bank-x", kind: "income", amount_minor: -1800, merchant_raw: "JANE TAN" },
			{ account_id: "bank-x", kind: "purchase", amount_minor: 4000, merchant_raw: "JANE TAN (Mobile ending 5678)" },
		]);
	});

	it("…and the owner's payee rule for that person decides what it is", async () => {
		db.raw.prepare("INSERT INTO payee_rules (merchant_key, kind, category, set_by, updated_at) VALUES ('JANE TAN', 'friend_transfer', NULL, 'owner', 'x')").run();
		const g = new FakeGmail().add(mail({ id: "person", from: "DBS <ibanking.alert@dbs.com>", subject: "iBanking Alerts", text: DBS_PAYNOW_PERSON, received_at: "2026-10-13T05:00:00.000Z" }));
		queue("person");
		await tick({ gmail: g, claude: noClaude() }, SUB);
		expect(lines()).toEqual([{ account_id: "bank-x", kind: "friend_transfer", amount_minor: 4000, merchant_raw: "JANE TAN (Mobile ending 5678)" }]);
	});

	it("an alert the built-ins do not know still goes to the reader, exactly as before", async () => {
		const g = new FakeGmail().add(mail({ id: "bill", from: "DBS <ibanking.alert@dbs.com>", subject: "iBanking Alerts", text: DBS_BILL, received_at: "2026-10-13T05:00:00.000Z" }));
		queue("bill");
		await tick({ gmail: g, claude: noClaude() }, SUB);
		expect(tasks()).toEqual([{ kind: "alert_unknown" }]);
		expect(lines()).toEqual([]);
	});

	it("a bank-named alert from an unknown address raises an alarm naming it", async () => {
		const g = new FakeGmail().add(mail({ id: "odd", from: "HSBC Singapore Transaction Alerts (Credit Card) <alerts@hsbc-mailer.example>", subject: "Transaction Alert", text: HSBC_BODY, received_at: "2026-10-13T05:00:00.000Z" }));
		queue("odd");
		await tick({ gmail: g, claude: noClaude() }, SUB);
		const alarms = db.raw.prepare("SELECT key, message FROM alarms WHERE cleared_at IS NULL").all() as { key: string; message: string }[];
		expect(alarms.map((a) => a.key)).toEqual(["bank_sender_unknown:HSBC"]);
		expect(alarms[0]!.message).toContain("alerts@hsbc-mailer.example");
	});
});
