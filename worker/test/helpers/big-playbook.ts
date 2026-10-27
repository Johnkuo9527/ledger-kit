/// A made-up playbook the size of the live one in October 2026 (v115: about
/// 31,500 characters as the whole-playbook prompt — almost all of it the
/// merchant → category rules). Every merchant, name and address here is
/// invented; nothing comes from the owner's real ledger.

import { PLAYBOOK_SCHEMA, type Playbook } from "../../../src/playbook";

const CATEGORIES = ["Food", "Groceries", "Transport", "Travel", "Shopping", "Bills", "Health", "Entertainment", "Subscriptions", "Education", "Gifts", "Home", "Fees", "Others"];
const WORDS = ["KOPI", "NOODLE", "MART", "CAFE", "BAKERY", "TAXI", "BOOKS", "PHARMACY", "CINEMA", "FLORIST", "HARDWARE", "SUSHI", "TEA", "GYM", "LAUNDRY", "OPTICAL"];
const PLACES = ["ORCHARD", "TAMPINES", "BUGIS", "JURONG", "QUEENSTOWN", "NEIHU", "DAAN", "ZHONGSHAN"];

export function bigPlaybook(): Playbook {
	const rules: Playbook["category_rules"] = [];
	for (let i = 0; rules.length < 385; i++) {
		const key = `${WORDS[i % WORDS.length]} ${PLACES[Math.floor(i / WORDS.length) % PLACES.length]} ${100 + i}`;
		rules.push({ merchant_key: key, category: CATEGORIES[i % CATEGORIES.length]!, ...(i % 40 === 0 ? { by: "owner" as const } : {}) });
	}
	return {
		schema: PLAYBOOK_SCHEMA,
		summary:
			"The owner holds two DBS cards and a DBS savings account, an HSBC card, a Citi card and a Taishin card billed in TWD. He spends mostly on food and transport in Singapore, with trips abroad every few months where the Taishin card and cash carry the spending. " +
			"Salary arrives monthly into DBS; card bills are paid from DBS by GIRO. Larger lines are flights and hotels booked online, and a handful of subscriptions renew monthly. " +
			"Older months, read later: the same pattern, with more taxi rides and fewer subscriptions.",
		own_names: ["ALEX DOE", "DOE ALEX", "J DOE"],
		senders: {
			alerts: [
				{ institution: "dbs", from: "ibanking.alert@dbs.com" },
				{ institution: "hsbc", from: "@hsbc.com.sg" },
				{ institution: "citi", from: "alerts@citibank.com.sg" },
				{ institution: "taishin", from: "@taishinbank.com.tw" },
			],
			statements: [
				{ institution: "dbs", from: "estatement@dbs.com", account_id: "card-a", password_secret: "LEDGER_PDF_PW_DBS" },
				{ institution: "hsbc", from: "@hsbc.com.sg", account_id: "card-h", password_secret: "LEDGER_PDF_PW_HSBC" },
				{ institution: "taishin", from: "@taishinbank.com.tw", account_id: "card-t", password_secret: "LEDGER_PDF_PW_TAISHIN" },
			],
			receipts: Array.from({ length: 30 }, (_, i) => `shop${i}.example.com`),
			ignore: Array.from({ length: 12 }, (_, i) => `news${i}@offers.example.com`),
		},
		alert_patterns: Array.from({ length: 6 }, (_, i) => ({
			id: `learned-alerts${i}@bank.example-${i + 1}`,
			institution: ["dbs", "hsbc", "citi"][i % 3]!,
			from: `alerts${i}@bank.example`,
			subject: "Transaction Alert",
			body: "(?:card|account) ending (?<last4>\\d{4})[\\s\\S]*?(?<currency>[A-Z]{3}) ?(?<amount>[\\d,]+\\.\\d{2})[\\s\\S]*?(?:at|to) (?<merchant>[^\\n]+?) on (?<date>\\d{1,2} [A-Z][a-z]{2} \\d{4})(?: at (?<time>\\d{2}:\\d{2}))?",
			kind_hint: "purchase" as const,
			default_currency: "SGD",
			date_format: "D MMM YYYY" as const,
		})),
		merchant_aliases: Array.from({ length: 25 }, (_, i) => ({ pattern: `${WORDS[i % WORDS.length]} ${PLACES[i % PLACES.length]}`, canonical: `${WORDS[i % WORDS.length]} (${PLACES[i % PLACES.length]})` })),
		categories: CATEGORIES,
		category_rules: rules,
		person_keys: Array.from({ length: 20 }, (_, i) => `PAYNOW PERSON ${i}`),
		judgement_notes:
			"Alerts from DBS PayNow to a person are transfers unless the owner says otherwise. A Taishin alert prints the amount in TWD with no decimals. " +
			"HSBC alerts sometimes print the merchant on a second line; join it. A GIRO payment to a card is a payment, never spending. Refunds print 'CR' on statements: direction in. " +
			"Foreign charges on DBS print the foreign amount first and the SGD amount after; report the foreign one as amount and currency. When a statement's balances do not add up, re-read the lines before saying unsure. " +
			"Taishin's one monthly bill lists every card the owner holds there; say on each line which card it was charged on. Citi statements arrive only as uploads. " +
			"An HSBC alert for a pre-authorisation (hotel, car rental) may never post; report it as printed. Grab and Gojek rides are transport even when billed by a payment processor. " +
			"Overseas ATM withdrawals are atm with the foreign currency. A merchant name printed in Chinese is copied as printed, never translated. " +
			"Interest and annual fees are fees; a fee waiver printed as a credit is a rebate. Cashback credited to a card is a rebate. Instalment plans print one line a month: each is a purchase.",
		escalate_when: ["an amount over SGD 5,000", "a card number not seen before", "a statement whose balances do not add up", "a sender claiming to be a bank from a new address", "a refund with no matching purchase"],
	};
}
