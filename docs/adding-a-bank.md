# Adding a bank

Any bank whose alert emails or statements reach your Gmail can be read. You add it in your accounts
file — **no code** — by naming the bank and the mail domains it sends from.

Why the domains: anyone can send an email that *looks* like a bank's. The ledger trusts an email as a
bank's only when **both** hold:

1. its sender's domain is one of **your** bank's domains on your list, and
2. Gmail itself confirms the email really came from that domain (DMARC/DKIM, in Gmail's own
   "Authentication-Results" — the sender cannot write it).

Anything else is at most a receipt, which can never create a line or teach the ledger a card number.
What an AI reader writes after reading an email is treated as data too: an alert lands on the bank Gmail
vouched for, whatever bank the reader names.

## Steps

Example: a made-up UK bank, "Thames Bank", whose alerts come from `alerts@thamesbank.co.uk` and whose
statements come from `statements@mail.thamesbank.co.uk`.

1. **Find its domains.** In Gmail, open one alert email and one statement email from the bank; the part
   of the sender's address after `@` is the domain. A domain covers its sub-domains, so
   `thamesbank.co.uk` covers `mail.thamesbank.co.uk` too. Never add a public mailbox (gmail.com,
   outlook.com, …): the accounts check refuses it.

2. **List it** in `seed/accounts.json` under `"banks"`:

   ```json
   { "institution": "thames", "name": "Thames Bank", "domains": ["thamesbank.co.uk"], "sender_names": ["thamesbank"] }
   ```

   | Field | What to put |
   |---|---|
   | `institution` | A short lower-case id you choose. Its accounts use the same id. |
   | `name` | How you call it: the page and the alarms say this. |
   | `domains` | Every domain its alerts and statements come from. |
   | `sender_names` | Optional. Words its alert emails' sender NAME uses even from another address ("iBanking Alerts" → `ibanking`). The Gmail search also looks for these, and an alert naming them from an address not on your list raises a warning that names the address. One word each. |
   | `pdf_password` | Optional. `false` only if this bank emails its statements as PDFs **without** a password. By default an unlocked "statement" is refused, because the banks this kit started with all lock theirs. |

3. **Its accounts** — the cards and accounts with `"institution": "thames"` (`docs/accounts.md`).

4. **Load it**: the two blocks in `docs/accounts.md` (`npm run seed:sql` in the kit's folder, then the
   `d1 execute` from its `worker` folder).
   Loading replaces the stored bank list, so removing a domain stops trusting it. No deploy is needed:
   the ledger reads the list on its next minute.

5. **Its PDF password**, if its statements are locked (from `worker`):
   `npx wrangler secret put LEDGER_PDF_PW_THAMES -c ../wrangler.toml` — the id in capitals, any `-`
   written as `_`. Statements that open **without** a password: `"pdf_password": false` on the bank
   instead (step 2), or answer **n** for it at setup stage 14, which writes that and loads the list.

## What happens then

- **Alerts** are read by your Claude reader (the subscription routines or the API), so they appear after
  the next reader run, within the hour. After three alerts from one sender have been read by the senior
  reader, it writes a pattern for that sender; from then on the bank's alerts are read by the pattern,
  instantly and free. An amount printed the bank's way ("1.234,56", "12,50 €") is read as such.
- **Statements** are read by the reader and joined to the alert lines: one line per purchase, and a
  foreign charge's estimate is replaced by what the bank billed.
- **Ready-made readers** exist for the alert formats of DBS/POSB, Citi Singapore and HSBC Singapore
  (ids `dbs`, `citi`, `hsbc`): those are read the moment they arrive. They are examples; they are used only
  for a bank you list under that id, and only for mail Gmail vouched for.

## When something is off

- **`bank_sender_unknown`** on the page: an alert naming one of your banks came from an address not on
  its list. The message names the address. If it is really the bank's, add its domain and load again.
- **`bank_unverified`**: mail from one of your bank's domains failed Gmail's check, so it was read only as
  a receipt. Usually a fake; if it keeps happening with real mail, the bank's own mail setup is unusual —
  ask the bank, never weaken the check.
- **`no_banks`**: your list is empty, so nothing can be read as a bank's.

The path is covered by the kit's tests with a made-up foreign bank at a pound-sterling home (trusted
alert, a spoof refused, an unlisted bank ignored, a pattern learned, the statement merged). Still, check
the first few purchases of a new bank by hand.
