# Your accounts file: `seed/accounts.json`

The ledger only records money on accounts it knows, and only trusts mail from banks you list. This file
holds both: your **banks** (and the mail domains each sends from) and every card, bank account, prepaid
wallet and cash. It is personal, so git ignores it; `seed/accounts.example.json` is the template.

After any change: `npm run seed:sql` in the kit's folder (checks the file and writes `seed/accounts.sql`),
then load it from the `worker` folder (write the kit's real path into each `cd`):

```sh
cd ~/Downloads/ledger-kit-main
npm run seed:sql
```

```sh
cd ~/Downloads/ledger-kit-main/worker
npx wrangler d1 execute ledger-db --remote -c ../wrangler.toml --file ../seed/accounts.sql
```

Loading is safe to repeat: an account already in the database is left as it is. To change an account
that is already loaded, change it on the page (card settings) or ask a developer; editing the file does
not overwrite it. The bank list is different: loading **replaces** it, so an edit to it always counts.

## Your banks (`"banks"`)

```json
"banks": [
  { "institution": "thames", "name": "Thames Bank", "domains": ["thamesbank.co.uk"], "sender_names": ["thamesbank"] }
]
```

Each bank whose emails should be read: its id (used by its accounts), its name, and **every** mail
domain its alerts and statements come from. Only mail from these domains, confirmed by Gmail, is ever
read as a bank's. Full guide, with the optional fields: `docs/adding-a-bank.md`. `"banks": []` is allowed
(cash and Apple Pay only), and the page then says no bank email is read.

A card or bank account whose bank is not on the list is refused by the check, unless it says
`"alerts_expected": false` (its statements then come only by upload).

Per bank, three answers decide its fields: does it email **alerts** (no → `"alerts_expected": false` on
its cards), does it email **statements** (no → `"has_statements": false`), and are the statement PDFs
**locked** (no → `"pdf_password": false` on the bank; yes → its password at setup stage 14).

## One entry per account

```json
{ "id": "hsbc-card", "institution": "hsbc", "kind": "credit_card", "name": "HSBC card 1234",
  "last4": "1234", "currency": "SGD", "wallet_names": ["HSBC Visa Platinum"] }
```

| Field | What to put |
|---|---|
| `id` | A short name you choose, lower case with dashes: `dbs-bank`, `hsbc-card`. Never change it after loading. |
| `institution` | A bank's id from your `banks` list, or `grab` (GrabPay), `cash`, or for a prepaid shop card a short name of your own (`sample-bistro`). |
| `kind` | `credit_card`, `debit_card`, `bank` (a bank account), `wallet` (GrabPay or a prepaid shop card), `cash`. A card that takes money straight from a bank account is a `debit_card` (in many countries a "Visa" card is one): list that bank account too and name it in `settles_to`. |
| `name` | What the page shows. Anything readable: `DBS account 1234`, `台新 card 5678`. |
| `last4` | The last 4 digits as the bank prints them in its emails. `null` for cash and wallets. |
| `currency` | The currency the account is billed in (ISO code: `EUR`, `GBP`, `SGD`, `TWD`…). Usually your home currency (`LEDGER_HOME_CURRENCY`); a card billed in another currency (a 台新 card in TWD for an owner in Singapore) is converted at a reference rate. Cash and wallets: your home currency — set it before loading (the example's cash says SGD). |
| `wallet_names` | Optional. The card's name exactly as **Apple Wallet** shows it, so an Apple Pay tap knows the card. Leave `[]`: an unknown card's first tap waits under 待確認 and you name it there once. |
| `settles_to` | Debit cards only: the `id` of the bank account the card draws on. The bank account must be listed too. |
| `alerts_expected` | `false` when the bank sends no email alerts for this card (台新). The page then says "complete up to the last statement" instead of warning. |
| `has_statements` | `false` when no statement reaches the ledger by email (Citi: upload its PDFs with the share shortcut — the first one switches this on). |
| `active`, `replaced_by` | A lost card: `"active": false` and `"replaced_by": "<the new card's id>"`; its old statements still count. |

## Wallets (`"kind": "wallet"`)

A wallet holds prepaid money: GrabPay, or a restaurant or shop card you top up. Money moved into it is
never spending; what you buy from it is spending, once.

```json
"wallet": {
  "since": "2026-01-01",
  "opening_balance": "0.00",
  "precounted": "0.00",
  "precounted_category": "Food",
  "topup": { "merchant": "SAMPLE BISTRO", "whole_dollars": true, "deal": { "paid": "200.00", "credit": "240.00" } },
  "spend_category": "Food",
  "sms": { "keywords": ["SAMPLE BISTRO"], "sender": "RestoSuite" }
}
```

| Field | What to put |
|---|---|
| `since` | The day the ledger starts keeping this wallet (YYYY-MM-DD). Nothing before it counts. |
| `opening_balance` | What is in it at the start of that day, in the shop's credit. |
| `opening_paid` | Optional: what that credit cost you, when the shop gave bonus credit. Default: the same as the balance. |
| `precounted` | How much of that cost was already counted as spending (because an earlier card top-up was recorded as a purchase). Usually `"0.00"` on a new ledger. |
| `precounted_category` | The category those old top-ups were in (needed when `precounted` is above zero). |
| `topup` | Prepaid shop cards only (GrabPay's rule is built in): a card or bank line whose merchant contains `merchant` (several names: comma-separated) is a top-up; `whole_dollars: true` = only round amounts (100, 200 in your currency); `deal` = the shop's usual bonus ("pay 200, get 240"). |
| `spend_category` | The category a purchase from this card takes when you name none. |
| `sms` | Only if the shop texts after each use: `keywords` = words its SMS always contains (any one must appear); `sender` = the sender name, which your SMS Shortcut sends with each text. An SMS must match both to count. Then build the SMS automation in `docs/iphone-shortcuts.md`. |

`npm run seed:sql` explains anything it refuses.
