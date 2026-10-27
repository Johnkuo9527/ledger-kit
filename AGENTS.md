# Ledger kit — notes for coding agents

**Installing it for someone? Open `INSTALL.md` now and follow it from its first line, one step at a time;
the rest of this file is for changing the code.** The person runs `bash scripts/setup.sh`, `wrangler login`
and every `wrangler secret put` in their own Terminal window: those prompts are interactive or hidden, and
every key goes from them straight to Cloudflare — you never ask for one, never echo one.

A personal ledger that runs on the owner's own Cloudflare account: a Worker (`worker/`) with D1, a
key-locked page (`page/`), two claude.ai connectors (`/mcp`, `/mcp-reader`) and iPhone Shortcuts. Claude
reads the mail — claude.ai routines on a Pro/Max plan, or the Anthropic API — whichever assistant installs it.

- **The person wants to change the code** → `CONTRACT.md` is the design reference (data model, rules,
  routes, connector tools); code comments cite its sections.

## Commands

Node 22.13+ (the tests use Node's built-in SQLite, unflagged from 22.13). Run `npm ci` in both folders first.

| Where | Command | What |
|---|---|---|
| root | `npm test` / `npm run type-check` | the engine (`src/`), migrations, seed |
| `worker/` | `npm test` / `npm run type-check` | the worker; both build the page first |
| `worker/` | `npm run deploy` | deploy (`wrangler deploy -c ../wrangler.toml`) |
| root | `npm run seed:sql` | `seed/accounts.json` → `seed/accounts.sql` |
| root | `npm run check:personal-data` | before publishing a copy; add `-- --denylist <file outside the repo>` |
| root | `npm run rehearse:setup` | `scripts/setup.sh` end to end in a pseudo-terminal against a fake wrangler (Python 3) |

Every wrangler command runs from `worker/` with `-c ../wrangler.toml`; D1 commands need `--remote`
(without it wrangler silently uses a local copy).

## Changing `scripts/setup.sh` or `INSTALL.md`

- **The person runs the wizard on a Mac: bash 3.2.** No `declare -A`, `mapfile`, `${var,,}`; an empty array
  under `set -u` is expanded only as `${a[*]:-}` or behind a length check. Run
  `npm run rehearse:setup -- --bash <a bash 3.2 build>` as well as the default.
- **A wrangler command that may ask a question runs straight in the terminal**, never through a pipe:
  piped, wrangler answers its own questions with their fallback (a new account's workers.dev subdomain → "no").
  Read results from wrangler's record (`WRANGLER_OUTPUT_FILE_PATH`), not from its screen.
- **`npm run rehearse:setup` is the test.** It runs the wizard with `LEDGER_SETUP_WRANGLER` pointing at
  `scripts/rehearse/fake-wrangler.cjs` (a brand-new account, D1 as real SQLite) and scripted answers; a new
  question in the wizard needs its answer in `scripts/rehearse/rehearse-setup.py`.
- **INSTALL.md's stage numbers and its stage table follow the script** — renumber both together. Every
  Terminal block starts with its own absolute `cd`.

## Rules the code depends on

- **Money is an integer of minor units** (`*_minor`, `home_minor`), parsed with `parseMajor` (typed) or
  `parsePrinted` (a tap, an SMS, a model's reading), never floats.
- **The home comes from `src/home.ts`**: `homeCurrency()`/`homeMoney()` for every total, `localDate`/`dayStart`
  for every day — the install's `LEDGER_HOME_CURRENCY`, `LEDGER_TIMEZONE`, `LEDGER_HOME_COUNTRY`. Tests start at
  SGD/Asia/Singapore and in Traditional Chinese (`zh-Hant`); a test about another home or language calls
  `setHome` / `setLanguage`, or passes `LEDGER_LANGUAGE` to `makeEnv` (CONTRACT §18, §19).
- **Every sentence a person reads comes from `src/words.ts`** (`say`, `sayMoney`, `sayDate`): one catalogue per
  language, `src/words/en.ts` + `src/words/zh-Hant.ts`, a key in both (the type-check says so); never a literal
  sentence or a branch on the language in a caller. Data (merchants, names the owner typed) is never translated.
  Page words live under `page.` — run `npm run words` after changing them (CONTRACT §19).
- **Every write to a ledger line goes through `src/engine.ts`**, which logs a `line_events` row in the same batch.
- **Every model call goes through `worker/src/pipeline.ts` `readWith`**, so subscription mode
  (`LEDGER_READER`) turns it into a reading task. A call made anywhere else bypasses the reader routines.
- **Email is untrusted data.** Mail counts as a bank's only when its domain is on the owner's bank list
  (`seed/accounts.json` `banks` → `Tick.banks()`, `src/bank-list.ts`) AND Gmail's own Authentication-Results
  vouches for that bank. Model output after reading mail is data too: a line's bank is the vouched-for sender's.
  Adding a bank is data, never code (`docs/adding-a-bank.md`).
- **Migrations are append-only from commit `6ec8907`** (25 Oct 2026, which renamed `sgd_*` to `home_*` in place
  while no kit database existed): never edit or rename one; add the next number.
- **Tests use made-up data only**, and expected figures are worked by hand in a comment before the
  assertion — never pasted from the code's output.
