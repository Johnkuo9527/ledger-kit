# Troubleshooting

Commands run from the `worker` folder: start each with `cd <the kit's folder>/worker`. Each secret is set
with `npx wrangler secret put <NAME> -c ../wrangler.toml` (the person types the value at a hidden prompt —
nothing appears while typing; never in a chat). Re-running `bash scripts/setup.sh` from the kit's folder is
the easy way: it skips what is done and offers to replace each secret already set.
The page's top strip shows the ledger's own alarms in plain words — start there.

## During setup

| What happened | What to do |
|---|---|
| `npm test` fails right after download | Check `node --version` is 22.13 or newer (older Node has no built-in SQLite: errors name `node:sqlite`), then `npm ci` again in both the main folder and `worker`. Still failing: report the failing test's name to a developer — do not deploy. |
| `npm ci` reports `N vulnerabilities` | Expected; install anyway. Never `npm audit fix --force` — it moves libraries to versions the ledger was not built for. Fixes come with a kit update. |
| Terminal: `command not found`, or a full-width `ｎｐｍ` / `：` | The keyboard was on a Chinese (or other) input method: switch to **ABC** and paste the block again. |
| Terminal: `No such file or directory` after `cd` | The folder is elsewhere or named differently: in Finder, find the kit's folder (`<repository>-main` after a ZIP download) and use its path in every block. |
| `wrangler` says it is not logged in, or uses the wrong account | `npx wrangler logout`, then `npx wrangler login` and pick the right account. |
| The deploy fails mentioning **CPU limits** or the plan | The account is on the Free plan. Switch to **Workers Paid** in the Cloudflare dashboard (Workers & Pages → Plans), then deploy again. |
| The deploy asks for a **workers.dev subdomain** | Answer **y** and pick any short name (letters, digits, dashes); it becomes part of the ledger's address. |
| Setup stops at stage 9: "register a workers.dev subdomain here" / "The ledger is not online yet" | The account has no workers.dev subdomain (or the question was answered n). Cloudflare dashboard → **Workers & Pages** → choose a subdomain → run `bash scripts/setup.sh` again; it skips everything already done. |
| The address shows a security / SSL error | Normal for a few minutes after the first deploy. Wait, then reload. |
| The page or a connector says **"This ledger is not set up yet"** | `LEDGER_HOME_CURRENCY`, `LEDGER_TIMEZONE`, `LEDGER_HOME_COUNTRY` or `LEDGER_LANGUAGE` (`en` or `zh-Hant`) in `wrangler.toml` is missing or wrong (the message says which). Run `bash scripts/setup.sh` again (stage 3 writes them, stage 9 deploys), or fix them by hand and deploy (`npm run deploy` in the `worker` folder). |
| `wrangler.toml` still says `REPLACE-WITH-YOUR-…` | Run `bash scripts/setup.sh` again (stages 3 and 6 fill them), or copy the ids from `npx wrangler d1 list` and `npx wrangler kv namespace list` by hand. |
| A migration command lists nothing to apply | Already done; fine. Always keep `--remote` in it: without it wrangler uses a practice copy on the computer. |
| `npm run seed:sql` refuses the accounts file | It lists each problem; fix those lines in `seed/accounts.json` (`docs/accounts.md`). A card "whose bank is not in banks": add the bank and its mail domains under `banks` (`docs/adding-a-bank.md`). |
| Page: **「no_banks」 / no bank on the list** | The `banks` list is empty, so no email can be a bank's. Add your banks to `seed/accounts.json`, `npm run seed:sql`, load it again. |
| Page: **LEDGER_HOME_CURRENCY is now X, but this ledger's amounts are all in Y** | The home currency was changed after money was recorded. Set it back to Y in `wrangler.toml` and deploy; a ledger keeps one currency for good (start a new database for another). |

## Google and Gmail

| What happened | What to do |
|---|---|
| Google shows `redirect_uri_mismatch` | The client's **Authorised redirect URI** must be exactly `ADDRESS/google/callback` (no slash at the end) on the `Ledger` client, saved. Google can take 5 minutes to accept a change. |
| "Google hasn't verified this app" | Expected for a personal app: **Advanced → Go to Ledger (unsafe)**. |
| Google will not publish the app | Branding needs the home page `ADDRESS`, privacy policy `ADDRESS/privacy` and the authorised domain (the address after `ledger.`). |
| Google refuses `workers.dev` as an authorised domain, or asks to **verify** the app or the Gmail scope before publishing | Not yet tried on a brand-new Google account; Google's rules change. Publish anyway if it allows ("verification not required" for a personal app); if it will only stay in **Testing**, the ledger works but Google cancels its access every 7 days — reconnect Gmail on the page each week, and tell the kit's maintainers what Google said. |
| Email / page: **Google refused the ledger's sign-in** | Usually the app was left in "Testing" (access ends after 7 days) or the Google password changed. Publish the app (**Audience → Publish app**), then on the page tap **「重新連接 Gmail」**. Nothing is lost: it catches up. |
| "Gmail connected: …" (「Gmail 已連接：…」) shows the wrong mailbox | Tap **Reconnect Gmail** (「重新連接 Gmail」) and pick the mailbox the bank alerts go to. |
| "Gmail has not been checked for a while" · 「好一陣子沒檢查 Gmail 了」 | Gmail has not answered for two hours. It catches up by itself; if it lasts a day, ask a developer. |
| "… has sent no transaction alert email for N days" · 「…已經 N 天沒有寄交易通知 email 來了」 | That bank's alert emails stopped arriving while others did. Check the bank app's email alert settings; if the bank changed its sender address, add the new domain to that bank in `seed/accounts.json` and load it again (`docs/adding-a-bank.md`). |

## Statements

| What happened | What to do |
|---|---|
| A statement "would not open" (To review → Passwords · 待確認 → 密碼) | Set that bank's PDF password: `npx wrangler secret put LEDGER_PDF_PW_<BANK> -c ../wrangler.toml` (e.g. `LEDGER_PDF_PW_HSBC`). The message names the exact command. It is tried again daily; nothing is lost. |
| One card at a bank uses a different PDF password | Set it for that card alone with its account id: `LEDGER_PDF_PW_<ACCOUNT_ID>` (upper case, dashes as underscores). That one is tried first. |
| A bank's statements never appear (Citi Singapore emails none) | Share each PDF with **Send to Ledger** (`docs/iphone-shortcuts.md`) or drag them onto **Upload statements** (上傳帳單) on the page. |
| To review → Uploads (待確認 → 上傳) asks which card | The ledger could not tell from the PDF: pick the card there. |

## Claude: connectors and reading

| What happened | What to do |
|---|---|
| The 6-digit code never arrives | `RESEND_API_KEY` must be set, and `LEDGER_OWNER_EMAIL` must be the address the Resend account is registered under (Resend's shared sender delivers only there). Check spam. |
| A connector says "this sign-in is for the Ledger connector, not the Ledger Reader" (or the reverse) | It was added with the wrong address. Remove it in claude.ai and add it again: `Ledger` = `ADDRESS/mcp`, `Ledger Reader` = `ADDRESS/mcp-reader`. |
| "The Claude that reads your mail has not come for a while" · 「讀信的 Claude 好一陣子沒來了」 | Subscription mode: the message names the late routine (daily runs hourly, senior every 12 hours). At https://claude.ai/code → **Routines**, check both are on and their last run ended with the one-line summary. If a run says the connector refused it, reconnect `Ledger Reader` in claude.ai → Settings → Connectors. |
| A routine run says it answered 0 | Normal when nothing is waiting. |
| (api) Email: "Your Anthropic API credit has run out" | Top up at https://platform.claude.com, then update `LEDGER_API_CREDIT_USD` and `LEDGER_API_CREDIT_SINCE` in `wrangler.toml` and `npm run deploy`. |
| (api) "The backfill has spent the amount you approved" | Set a higher `LEDGER_BACKFILL_APPROVED_USD`. |
| (api) "Reading uploaded statements needs your approval to spend" · 「讀上傳的帳單需要你核准花費」 | Uploaded statements have their own approval: set `LEDGER_CATCHUP_APPROVED_USD` (a US$ total). New bank emails are not affected. |
| (api) "Bank alert emails are stuck" · 「銀行通知信卡住了」 | The message says why. "Allowance used up": raise `LEDGER_DAILY_SPEND_CAP_USD` in `wrangler.toml` and deploy, or wait for midnight. |
| (api) Stop all spending now | `npx wrangler secret delete ANTHROPIC_API_KEY -c ../wrangler.toml`. The page and taps keep working. |

## Phone, keys and access

| What happened | What to do |
|---|---|
| **Lost the phone** | Run `bash scripts/setup.sh` again: at stage 10, **y** to a new Shortcut key (the old phone can no longer send taps; put the new key in the Shortcuts on the new phone), and **y** to a new page key and to signing out every browser (Gmail is reconnected once: tap 「重新連接 Gmail」 / **Reconnect Gmail**); then open the new page link. |
| **The page link leaked** | Run `bash scripts/setup.sh` again: at stage 10, **y** to a new page key and **y** to signing out every browser (a new `LEDGER_SESSION_SECRET`; Gmail is reconnected once on the page). |
| A key was pasted into a chat | Treat it as leaked: revoke it where it was made, then replace it — INSTALL.md "Secrets" has the table, per key. |
| **Cut Claude off** | Remove the connectors in claude.ai. To stop every Claude sign-in at once, also set `LEDGER_OWNER_EMAIL` to another address. |
| The page asks for the key again | The 90-day sign-in ended: open the page link from the password manager once more. |
| A Shortcut says `not authorised` | One space after `Bearer`, key complete, and the same key as `LEDGER_SHORTCUT_KEY`. |
