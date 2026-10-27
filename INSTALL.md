# Installing the ledger — a guide for the AI assistant

You are guiding a person who is **not an engineer** through installing this ledger on their own
Cloudflare account, their Google account, claude.ai and their iPhone. Your job is to be their patient
installer: one step at a time, in plain words, checking each step worked before the next.
Plan on 1–2 hours together; after that the ledger reads their past year of mail by itself over a few days.

## How to guide

- **One step per message.** Say what the step is for in one sentence, give the exact clicks or the
  exact command, then stop and wait for them to say it is done. Never hand over several steps at once.
- **Verify before moving on.** Every step ends with a **Done when** check. When it names a command, run it
  yourself if you can; otherwise give it to them and say exactly what to paste back. Not done → fix that
  step first (`docs/troubleshooting.md`).
- **Name every button twice when their screens are not in English**: the English name written here, and
  theirs. `docs/words-on-screen.md` has the page's own buttons in both languages and the Mac, iPhone and
  Google menus in Traditional Chinese. When what they describe does not match, ask for a screenshot.
- **Plain words.** Explain a term the first time it appears ("Terminal is the app where you type commands").
- **Keep a checklist** of the steps done and the values gathered (their choices from step 1, `KIT`,
  `ADDRESS`). At every pause, give it to them to save: a new chat starts empty, and they can paste it back.
- **If you cannot open a file this guide points to**, ask them to open it on GitHub and paste its text.

## Secrets: the person types them, you never see them

Keys, passwords and tokens go **straight from the person into Cloudflare**: they type them into the setup
script (or `wrangler secret put`) in their own Terminal, at a **hidden prompt — nothing appears while they
type or paste; that is normal: paste once, press Enter once.** Tell them, the first time a secret appears:
**"Do not paste this into our chat."**

Not secret, fine to share with you: their ledger's address, card last-4 digits, error messages, and command
output — except the setup script's screens from **stage 10 on** (stage 10 shows two keys; at stages 11–14 a
key typed at the wrong prompt would show). For those, ask for the last line only, after they check it holds
no key or password.

**If a secret reaches the chat anyway, it is leaked: revoke it where it was made, then make a new one.**
Changing it only in Cloudflare is not enough for the first three — the old one would still work.

| Pasted | Revoke and replace |
|---|---|
| Resend API key (`re_…`) | resend.com → **API Keys** → delete that key → **Create API Key**; then run the setup script again and answer **y** to "RESEND_API_KEY is already set. Replace it?" |
| Google Client secret | Google Cloud console → **Google Auth Platform → Clients → Ledger** → add a new secret, then delete the old one; run the setup script again, **y** to replace `GMAIL_CLIENT_SECRET` |
| Anthropic API key (`sk-ant-…`) | platform.claude.com → **API keys** → delete it → **Create key**; run the setup script again, **y** to replace `ANTHROPIC_API_KEY` |
| Page link (`…/unlock?key=…`) | Run the setup script again: stage 10, **y** to a new page key and **y** to signing out every browser (Gmail is then reconnected once on the page) |
| Shortcut key | Stage 10 again, **y** to a new Shortcut key; then put the new key in each iPhone Shortcut |
| A statement PDF password | Usually an ID or birth date the bank chose: nothing to revoke in the ledger. If it is a password they chose and use elsewhere, they change it there. |

Then ask them to delete the chat message too.

## Which kind of assistant you are

- **You run in the cloud, away from their computer** (a Codex cloud task, a hosted agent): stop here. The
  install needs their own browser sign-ins, their iPhone and their typing at hidden prompts. Tell them to
  start you again on their own computer, in the downloaded folder (Codex: the Codex CLI in Terminal, or the
  Codex app — README "With Codex").
- **You can run commands on their computer** (Claude Code, Codex, or similar): run the *Terminal* blocks
  yourself and show them the result. Anything that asks a question or a secret (`wrangler login`,
  `wrangler secret put`, `scripts/setup.sh`) they run in their **own** Terminal window, because you cannot
  type into its prompts and must not see secrets. **`bash scripts/setup.sh` always runs there — never in
  your shell**, even when you could start it: they open a second window (in Terminal, ⌘ + N), paste the
  block from step 5, and tell you each stage's last line.
  - **Internet access:** `npm ci`, every `npx wrangler …` and `npm run deploy` reach the internet. When your
    sandbox blocks the internet or asks for approval (Codex often does), ask them to approve that
    command, or give it to them for their own Terminal window. A command that fails with a network,
    permission or `operation not permitted` error inside a sandbox is the sandbox, not the kit: run it again
    with that access, or in their window, before you troubleshoot it.
  - **Already in the kit's folder?** If they started you in the downloaded folder, the code is on their
    computer: `KIT` is your working folder (`pwd`), and step 2 starts at its `npm ci` blocks.
- **You cannot run commands** (ChatGPT or Claude in a browser): give each *Terminal* block in its own
  copy-paste block, exactly as written below with `KIT` replaced by the real folder, and ask them to paste
  back the last few lines it printed. Before the first one, teach them:
  - **Open Terminal:** ⌘ + Space, type `Terminal`, press Enter.
  - **Typing:** switch the keyboard to **ABC** (English) first — a Chinese or other input method makes
    characters commands cannot read.
  - **Pasting:** paste the whole block, press Enter, wait for the prompt (the line ending in `%` or `$`) to
    come back before the next block. Lines starting `npm warn` are normal.
  - **Every block starts with its own `cd`**, so it works whatever ran before it. Never shorten a block.
- **Editing a file without a terminal assistant:** `open -e <file>` opens it in TextEdit. Before pasting,
  **Format → Make Plain Text** (if the menu offers it) and **Edit → Substitutions → Smart Quotes** off — curly
  quotes break the file. You give the **whole** new file; they select everything in the window (⌘A),
  paste (⌘V) and save (⌘S). They never retype part of a file. On Linux, `nano <file>` instead.

Steps marked *Browser* or *iPhone* are always done by the person; you tell them where to click.

## Step 1 — Check the requirements together

Go through the list with them and ask about each row. Accounts they do not have yet are fine — they sign
up in step 4; note them. **Stop only for what they cannot get**: an iPhone, a Mac or Linux computer, a way
for Claude to read (a Claude Pro/Max plan or Anthropic API credit), a card for the US$5/month.

**Only Claude reads the mail.** A ChatGPT or Codex subscription cannot be the reader, whichever assistant
guides this install: the reading runs either as claude.ai routines on a Claude plan or through the
Anthropic API. Say this before anything else, so they know before they spend an hour.

| Need | Notes |
|---|---|
| **iPhone, iOS 17 or later**, with the Shortcuts app | No Android path exists. Settings → General → About shows the iOS version. |
| **A password manager that syncs to the iPhone** (Apple's Passwords / iCloud Keychain, 1Password, Bitwarden…) — or a locked note in Apple Notes synced by iCloud | The setup script makes two keys on the computer that are needed **on the phone** (step 7 and step 10). |
| **Mac or Linux computer**, and its **admin password** | One-time setup. Windows: use WSL. The admin password installs Node.js. Homebrew and Xcode are not needed. |
| **Node.js 22.13 or newer** | `node --version` in Terminal. Missing or older: install the **LTS** from https://nodejs.org (the Mac installer asks for the admin password), then quit Terminal (⌘Q) and open it again. |
| **Cloudflare account on Workers Paid** (US$5/month) — needs a **payment card** | The free plan's 10 ms of CPU per run cannot open a statement PDF. D1 (database) and KV (sign-in store) are included. A new account also chooses its **workers.dev subdomain** (step 4): the ledger's address becomes `https://ledger.<subdomain>.workers.dev`. |
| **Gmail** where their bank alerts arrive | Gmail or Google Workspace. Read-only. |
| **Google Cloud** with that Google account | Free, no card. Only lets the ledger read Gmail. |
| **How Claude reads the mail** — pick one: | Write their choice down; it changes steps 5 and 9. |
| · *subscription* — **Claude Pro or Max** | Check now: https://claude.ai/code shows **Routines**, and claude.ai → **Settings → Connectors** shows **Add custom connector**. The two routines run on the plan's usage: one Sonnet run an hour, one Opus run every 12 hours, and in the first days the past 12 months of mail. On Pro the first days can reach the usage limit; reading then pauses until the limit resets — nothing is lost, the backfill is just slower. |
| · *api* — an **Anthropic API key** with prepaid credit (https://platform.claude.com) | Pay per use, separate from any Claude plan. The everyday reading is capped at US$3 a day (`LEDGER_DAILY_SPEND_CAP_USD`); reading the past year waits until they approve the price the ledger emails them (step 9), and pauses at that amount. |
| **Resend account** (free), https://resend.com | Sends the 6-digit sign-in codes for the Claude connectors and the ledger's alarm emails. The address they sign up to Resend with is where every code goes: Resend's free sender delivers only there. |
| **GitHub account** — only maybe | Downloading this kit as a ZIP needs none. Only if the claude.ai Routines form insists on a repository (subscription mode, step 9). |
| **Their language** | **English** (`en`) or **Traditional Chinese** (`zh-Hant`): the page, alarms, iPhone Shortcut replies and the connector's messages, and their starting spending categories. Changeable later (notes already written stay as written; categories are theirs to rename on the page). |
| **Their home** | Ask, never guess: the **currency** they live in (SGD, EUR, USD, GBP, JPY, TWD, AUD…; 3-decimal ones such as KWD are not supported), **time zone** as Region/City (Europe/Berlin, Asia/Taipei…) and **country** in 2 letters (DE, TW…). The currency cannot change once the ledger holds money. |
| **Their banks** — for each one, ask: | **Does it email alerts?** (if not: `"alerts_expected": false` on its cards) **Does it email statements?** (if not: `"has_statements": false`; PDFs can be shared from the iPhone later) **Are the statement PDFs locked with a password?** (if yes: they need the password at stage 14; if no: `"pdf_password": false` on the bank). Any bank works — they list it and its mail domains in step 3, no code. Ready-made instant readers exist for DBS/POSB, Citi Singapore and HSBC Singapore alerts; every other bank is read by their Claude reader. |

**Done when:** every row is answered, and your checklist holds their choice of *subscription* or *api*,
their language, currency, time zone and country, and the three answers for each bank.

## Step 2 — Get the code onto their computer *(Terminal)*

Already started in the downloaded folder (see "Which kind of assistant you are")? Go straight to the
`npm ci` blocks below.

**Recommended for non-engineers — the ZIP:** on this repository's GitHub page, the green **Code** button →
**Download ZIP**. The Mac unzips it into **Downloads** as a folder named after the repository with `-main`
(for this repository, `ledger-kit-main`). If a `.zip` file stays instead, double-click it.
With git (engineers): `git clone <this repository's URL>`. On a Mac without developer tools, `git` starts a
large Apple install — use the ZIP.

From here on, **`KIT`** means that folder's full path. The blocks below are written with the usual one,
`~/Downloads/ledger-kit-main`; if theirs differs, change it in every block before you give it. The first time Terminal opens a folder in Downloads, macOS asks whether Terminal may access
it: **OK**.

```sh
cd ~/Downloads/ledger-kit-main
npm ci
npm test
```

```sh
cd ~/Downloads/ledger-kit-main/worker
npm ci
npm test
```

What they will see, all expected:
- `npm warn deprecated …` lines, and `N vulnerabilities (… critical)` at the end of `npm ci`. **Never run
  `npm audit fix --force`**: it jumps libraries to versions the ledger was not built for. In both folders they
  are in the test and deploy tools (vitest, wrangler), which run on this computer and are never part of the
  deployed ledger; the libraries the ledger itself runs with had none when this kit was published
  (`npm audit --omit=dev` in `worker` shows `found 0 vulnerabilities`). Fixes arrive with a kit update (see Later).
- Red error text in the middle of a test run: some tests check failures on purpose. Only the summary counts.

**Done when:** each test run ends with a line `Tests  N passed` (any number) and no line containing `failed`.

## Step 3 — Write their banks and accounts file *(text editor)*

The ledger must know their banks to know whose email to trust, and their cards and accounts to know which
card each email is about. Read `docs/accounts.md` and `docs/adding-a-bank.md`, then write
`seed/accounts.json` with them, in the shape of `seed/accounts.example.json`:

1. **Banks** (`"banks"`): for each bank, `institution` (a short lower-case id you choose, e.g. `"thames"`),
   `name` (what they call it) and `domains` — **every** domain its alert and statement emails come from.
   Have them open one alert email and one statement email from each bank in Gmail and read you the sender's
   address after the `@` (`alerts@mail.examplebank.co.uk` → `examplebank.co.uk` covers it and its
   sub-domains). Never a public mailbox (gmail.com, outlook.com…). Statements open without a password
   (step 1)? Add `"pdf_password": false`. Delete the example banks they do not have.
2. **Accounts** (`"accounts"`), one at a time: the bank (`institution`, the id from 1), the `kind`
   (`credit_card`, `debit_card`, `bank`, `wallet`, `cash`), the **last 4 digits**, the `currency`, and the
   name their Apple Wallet shows for the card (optional). A **debit** card also needs its bank account listed,
   named in its `settles_to` — many "Visa" or "Mastercard" cards outside the US and Singapore are debit cards;
   ask. From step 1: `"alerts_expected": false` / `"has_statements": false` where the bank sends none.
   **Cash and wallets: set `currency` to their home currency now** (the example's cash is SGD; nothing checks
   it until setup stage 8, which then refuses it).

An assistant that runs commands writes `seed/accounts.json` itself (copy the example, then write the whole
file) and shows it to them to check. Otherwise the assistant writes the whole file and they paste it in
(see "Editing a file" above):

```sh
cd ~/Downloads/ledger-kit-main
cp seed/accounts.example.json seed/accounts.json
open -e seed/accounts.json
```

After they save it:

```sh
cd ~/Downloads/ledger-kit-main
npm run seed:sql
```

The file stays on their computer: git ignores it.

**Done when:** it prints `Wrote seed/accounts.sql: B bank(s), N account(s).` with B = their banks and
N = their accounts. If it refuses, it lists why (e.g. a card whose bank is not under `banks`): fix, save, run again.

## Step 4 — Sign up where needed *(Browser)*

1. **Cloudflare** — https://dash.cloudflare.com/sign-up. Then **Workers & Pages → Plans** (the menu may read
   **Compute → Workers → Plans**) → **Workers Paid**, paid by card. Then open **Workers & Pages** once: a new
   account offers to choose its **workers.dev subdomain** — any short name (letters, digits, dashes). If it
   does not offer one, the setup script asks at stage 9.
2. **Resend** — https://resend.com, signed up with the address the sign-in codes should go to. Its welcome
   screens push **Add domain**: skip it; the API key is made at setup stage 11.
3. **Google Cloud** — open https://console.cloud.google.com once: accept the terms and pick the country. A
   free-trial banner needs nothing; no card is asked for this.
4. *api mode only:* **Anthropic** — https://platform.claude.com: buy credit (US$25 is plenty to start),
   and under **Settings → Limits** set a monthly spend limit as a backstop.

**Done when:** Cloudflare shows **Workers Paid** (and the subdomain, if it offered one), and they can open
Resend and the Google Cloud console.

## Step 5 — Run the setup script *(their own Terminal window — never your shell)*

They run this block themselves, in a Terminal window of their own (a second one if you run in Terminal):
the script asks questions and hidden keys only they can type. Before they start, tell them three things:
**the screen clears at every stage** (only the current one shows); **typed secrets do not appear**;
**never paste the screen of stage 10 into the chat**.

```sh
cd ~/Downloads/ledger-kit-main
bash scripts/setup.sh
```

It shows one stage at a time (14 in all), in English, and is safe to run again: it skips what is done and
remembers their answers. Walk them through it with this table:

| Stage | It asks | They type |
|---|---|---|
| 1 Check this computer | "Run the tests now?" | **n** — step 2 ran them |
| 2 How the ledger reads your email | "Type subscription or api" | their choice from step 1 |
| 3 Your home and language | Currency, Time zone, Country, Language | **all four values from step 1**, typed. The offered defaults come from the computer's settings and can be wrong (a Mac set to English (US) offers `US`). A `zh-Hant` install also gets Chinese starting categories (餐飲, 交通 … 其他). |
| 4 Workers Paid | Enter | Enter, once Cloudflare shows Workers Paid |
| 5 Cloudflare sign-in | a browser window | **Allow**. Already signed in: "a DIFFERENT account?" → **n**, unless it named the wrong one |
| 6 Database and sign-in store | wrangler may ask whether to add them to the config | **n** |
| 7 Tables | "continue? (Y/n)" | **y** |
| 8 Banks and accounts | nothing when step 3 is done | if it lists problems: fix `seed/accounts.json`, Enter |
| 9 Put the ledger online | on a new account: "register a workers.dev subdomain now? (Y/n)", then its name | **y**, then a short name. It then prints the ledger's address: write it into the checklist as `ADDRESS`. |
| 10 Your three keys | shows the **page link** and the **Shortcut key** | they copy **both** into the password manager (step 1), then Enter — the screen clears |
| 11 Sign-in emails | "Email address for the sign-in codes", then "is that exactly right?" | the Resend sign-up address (in plain sight), **y** if right; then the **Resend API key** (hidden): resend.com → **API Keys → Create API Key** → name `Ledger`, **Sending access** → copy |
| 12 Gmail (Google) | waits | do **step 6** with them now; then the **Client ID** and the **Client secret** (hidden) |
| 13 Claude API key | *api mode only*: the Anthropic API key (hidden) | platform.claude.com → **API keys → Create key**. Afterwards: in `wrangler.toml`, `LEDGER_API_CREDIT_USD` = the credit bought and `LEDGER_API_CREDIT_SINCE` = today (YYYY-MM-DD), then the deploy block below |
| 14 Statement PDF passwords | per bank: "locked with a password? (y / n / Enter = skip)" | from step 1: **y** then the password (hidden); **n** if its PDFs open without one (the script writes `"pdf_password": false` and reloads the bank list); Enter if unsure |

The deploy block for stage 13 (and for any later change to `wrangler.toml`):

```sh
cd ~/Downloads/ledger-kit-main/worker
npm run deploy
```

**If it stops at stage 9** saying a workers.dev subdomain is needed: Cloudflare → **Workers & Pages**, choose
a subdomain, then run the script again. Any other stop: ask for the lines it printed (from stage 10 on,
check them for keys first), look in `docs/troubleshooting.md`, fix, run it again. If the script cannot run
at all, `docs/manual-setup.md` has the same steps as single commands.

**Done when:** it ends with **✓ Setup complete** and their ledger's address, and these two blocks (names only,
never values — safe to paste back) show their home values and every secret:

```sh
cd ~/Downloads/ledger-kit-main
grep -E '^LEDGER_(HOME_CURRENCY|TIMEZONE|HOME_COUNTRY|LANGUAGE|READER) ' wrangler.toml
```

```sh
cd ~/Downloads/ledger-kit-main/worker
npx wrangler secret list -c ../wrangler.toml
```

The list holds `LEDGER_UNLOCK_KEY`, `LEDGER_SESSION_SECRET`, `LEDGER_SHORTCUT_KEY`, `LEDGER_OWNER_EMAIL`,
`RESEND_API_KEY`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` (and `ANTHROPIC_API_KEY` in api mode, and a
`LEDGER_PDF_PW_…` per locked bank).

## Step 6 — Google: let the ledger read Gmail *(Browser)*

Signed in to https://console.cloud.google.com as **the Gmail account the bank alerts go to**. Google
renames menus often: if a name differs, look for the closest one, or ask for a screenshot.

1. **Project.** Top bar project picker → **New project** → name `Ledger` → **Create**. Keep `Ledger`
   selected for every step below.
2. **Gmail API.** Open https://console.cloud.google.com/apis/library/gmail.googleapis.com → **Enable**.
3. **Consent screen.** Menu → **Google Auth Platform** (older screens: **APIs & Services → OAuth consent
   screen**) → **Get started**. Its wizard asks the app name (`Ledger`), their email as support and contact
   address, and the audience (**External**) — fill what it asks, agree, **Create**. Then:
   - **Branding:** **App home page** `ADDRESS`; **Privacy policy** `ADDRESS/privacy`; **Authorised domains**:
     the part of the address after `ledger.` (e.g. `yourname.workers.dev`). Save.
   - **Audience:** **Publish app** → confirm, so it reads **In production**.
     ⚠️ In "Testing" Google cancels the ledger's access after 7 days. "In production" makes nothing public;
     only they can sign in. If Google refuses to publish or asks for a review: `docs/troubleshooting.md`.
   - **Data access:** **Add or remove scopes** → search `gmail.readonly` → tick
     `.../auth/gmail.readonly` → **Update** → **Save**.
4. **Client.** **Google Auth Platform → Clients → Create client** → type **Web application** → name
   `Ledger` → under **Authorised redirect URIs** → **Add URI** → `ADDRESS/google/callback` exactly
   (no slash at the end) → **Create**. Copy the **Client ID** and **Client secret** into the setup script's
   **stage 12**, never into the chat.

If the script has already ended without them: run it again (it skips what is done) and type them at stage 12.

**Done when:** the client exists with that redirect URI, the app reads **In production**, and the secret
list from step 5 shows `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.

## Step 7 — Open the page and connect Gmail *(iPhone)*

1. Open the **page link** from stage 10 (`ADDRESS/unlock?key=…`) in **Safari** on the iPhone — copy it
   from the password manager on the phone. The key vanishes from the address bar; the phone stays signed in
   for 90 days.
2. **Share → Add to Home Screen**.
3. On the page, tap **Connect Gmail** (連接 Gmail; top of the page) → pick the Gmail account with the bank
   alerts → "Google hasn't verified this app" is expected (it is their own): **Advanced → Go to Ledger
   (unsafe)** → tick the box allowing Ledger to read email → **Continue**.

**Done when:** the page shows **Gmail connected: their address** (「Gmail 已連接：…」) with the mailbox the
bank alerts go to.

## Step 8 — Add the Claude connector *(Browser, claude.ai)*

claude.ai → **Settings → Connectors** (https://claude.ai/customize/connectors) → **Add custom connector**:
name `Ledger`, URL `ADDRESS/mcp` → **Add** → **Connect** → enter their email (the address from stage 11)
→ type the 6-digit code that arrives (not in a minute? look in spam) → **Allow access**.

**Done when:** in a new claude.ai chat with the Ledger connector on, *"Using my ledger, what accounts do I
have?"* (「用我的帳本，列出我有哪些帳戶。」) lists their accounts.

## Step 9 — Turn on the reading

**Subscription mode** *(Browser, claude.ai)*:

1. Add a second connector the same way: name `Ledger Reader`, URL `ADDRESS/mcp-reader` (ends in
   `/mcp-reader`, not `/mcp`). Keep both connectors; each sign-in works only for itself.
2. Open https://claude.ai/code → **Routines** → **New routine**, twice:

   | Routine name | Schedule | Model | Prompt |
   |---|---|---|---|
   | `Ledger Reader — daily` | every hour | Sonnet | everything below the `---` line in `routines/reader-daily.md` |
   | `Ledger Reader — senior` | every 12 hours | Opus | everything below the `---` line in `routines/reader-senior.md` |

   In the form: the name and prompt; the **schedule** (hourly — if the form offers nothing that frequent,
   the most frequent it offers); the **model**; under connectors, **only** `Ledger Reader`, with its three
   tools allowed (`reader_next`, `reader_submit`, `reader_status`). The form changes often: ask for a
   screenshot when a field is not where this says. If it insists on a **repository**, pick any of theirs —
   the routine never reads or changes it; with none (ZIP users), they create an empty private one on GitHub
   (**New repository**) and pick that.
3. Press **Run now** on the daily routine.

**Done when:** the run ends with one line like `Daily reader: 3 answered, 0 refused, 0 still waiting.`
(0 answered is fine on the first day: the ledger may not have queued anything yet.) The first days can
hold many tasks while the last 12 months of mail are read (`LEDGER_BACKFILL_MONTHS`).

**API mode** *(email, then their own Terminal window)*: within a few hours of connecting Gmail, the
ledger emails a **dry run**: how much mail it found, what reading it will cost, and whether each bank's PDF
password worked. Fix any password it names (`docs/troubleshooting.md`). Then they set the most they will spend on
the first read (the higher figure in the email, rounded up), at a hidden prompt:

```sh
cd ~/Downloads/ledger-kit-main/worker
npx wrangler secret put LEDGER_BACKFILL_APPROVED_USD -c ../wrangler.toml
```

**Done when:** the secret is set and, over the next hours, purchases from past months appear on the page.

## Step 10 — iPhone Shortcuts *(iPhone)*

Open `docs/iphone-shortcuts.md` and walk them through it: the Apple Pay automation (every tap reaches
the ledger), the shop SMS automation (only if they have a prepaid card whose shop texts), and the
**Send to Ledger** (送到帳本) share shortcut for statement PDFs (needed for a bank that emails no
statement). The Shortcut key is the one saved at stage 10.

**Done when:** a small Apple Pay purchase shows a notification beginning `Recorded:` or `Held:`
(「已記下：」 or 「先放著：」) — `Held` = name that Wallet card once on the page under **To review** (待確認).

## Step 11 — Final check

- The page opens from the Home Screen and shows **Overview** (總覽) with no red notice (a grey note about a
  card that sends no alert emails is normal).
- In claude.ai, *"What did I spend this week?"* (「我這週花了多少？」) answers with their recent purchases.
- *subscription:* both routines are on and their last runs ended with their one-line summary.
- The first weekly summary email arrives on Monday morning, in their time zone.

Tell them what happens next: bank emails are read within the hour, statements when they arrive, and
anything the ledger is unsure of waits under **To review** (待確認) on the page for their decision.

## Later

- **Adding a bank, card or wallet:** edit `seed/accounts.json` (a bank under `banks` with its mail
  domains, `docs/adding-a-bank.md`), then:

  ```sh
  cd ~/Downloads/ledger-kit-main
  npm run seed:sql
  ```

  ```sh
  cd ~/Downloads/ledger-kit-main/worker
  npx wrangler d1 execute ledger-db --remote -c ../wrangler.toml --file ../seed/accounts.sql
  ```

  No deploy is needed: the ledger reads the new list on its next minute.
- **Updating the code.** Three files in their folder are theirs and are not in any download:
  `seed/accounts.json`, `.setup-state` (the script's memory) and their filled-in `wrangler.toml`.
  - *git:* `git pull` in `KIT` keeps all three; then run the setup script again.
  - *ZIP:* in Finder, rename the old folder (e.g. `ledger-kit-old`), download and unzip the new ZIP, then
    carry the two files over and run the setup script in the new folder — it fills the new `wrangler.toml`
    again from their Cloudflare account and its memory (Enter keeps each remembered answer; **n** to every
    "already set. Replace it?"):

    ```sh
    cd ~/Downloads
    cp ledger-kit-old/seed/accounts.json ledger-kit-main/seed/
    cp ledger-kit-old/.setup-state ledger-kit-main/
    ```

    ```sh
    cd ~/Downloads/ledger-kit-main
    bash scripts/setup.sh
    ```

    The script does not know values they changed by hand in the old `wrangler.toml` (API credit,
    `LEDGER_BACKFILL_MONTHS`, their own `LEDGER_CATEGORIES`…). Afterwards, compare the two files and carry
    those lines over, then deploy (the stage 13 block):

    ```sh
    cd ~/Downloads
    diff ledger-kit-old/wrangler.toml ledger-kit-main/wrangler.toml
    ```
- **Something broke, a phone was lost, a key leaked:** `docs/troubleshooting.md`.
