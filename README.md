# Ledger kit — an automatic personal ledger you host yourself

**EN** · Every card, bank and cash purchase in one list, read automatically from your bank alert emails,
your monthly statements and your Apple Pay taps — one line per real purchase, foreign charges estimated
until the statement confirms them, card bills never counted as spending. It runs on **your own**
Cloudflare account; your money data never leaves it. You read it on a key-locked web page (in English or
Traditional Chinese, your choice) and by asking Claude ("what did I spend on food in March?").

**繁中** · 自動記帳：把每一張卡、銀行帳戶、現金的消費整理成一張清單。資料來自你的銀行通知信、每月帳單和
Apple Pay 付款，一筆消費只記一行；外幣先估算、帳單來了再改成實際金額；繳卡費不算花費。整套程式跑在
**你自己的** Cloudflare 帳號上，資料不會離開你的帳號。用上鎖的網頁（英文或繁體中文介面，安裝時選）看帳，也可以直接問 Claude。

> [!IMPORTANT]
> ## Requirements · 需要準備的東西
>
> | | What you need · 需要什麼 | Why · 用途 |
> |---|---|---|
> | ☁️ | **A Cloudflare account on the Workers Paid plan (US$5/month), paid by card.** This is the cloud space: the program (Worker), its database (D1) and its sign-in store (KV) all live there. The **free plan is not enough** — the ledger opens statement PDFs every minute, far past the free plan's 10 ms of CPU per run. Your ledger's address is `https://ledger.<your-subdomain>.workers.dev`: a new account picks that workers.dev subdomain once. · **Cloudflare 帳號，Workers 付費方案（每月 5 美元，用信用卡付）**＝雲端空間。免費方案不夠用。新帳號要先選一個 workers.dev 子網域。 | Hosting · 主機 |
> | 📱 | **An iPhone (iOS 17 or later) with the Shortcuts app.** Apple Pay taps, shop SMS and sharing statement PDFs are sent by iPhone automations. **There is no Android path.** · **iPhone（iOS 17 以上）＋捷徑 App**。沒有 Android 版本。 | Taps, SMS, PDFs · 付款、簡訊、帳單 |
> | 🔑 | **A password manager that syncs to your iPhone** (Apple Passwords, 1Password, Bitwarden…, or a locked note in iCloud Notes): setup makes two keys on the computer that the phone needs. · **會同步到 iPhone 的密碼管理工具**（或 iCloud 上鎖的備忘錄）：安裝時電腦產生的兩把金鑰，手機也要用。 | Keys · 金鑰 |
> | ✉️ | **A Gmail address where your bank alerts arrive**, and a free **Google Cloud** project to let the ledger read it (read-only). · **收銀行通知信的 Gmail**，加上免費的 Google Cloud 專案（唯讀）。 | Bank emails · 銀行通知 |
> | 🤖 | **Either** a paid **Claude plan (Pro or Max) that shows Routines at claude.ai/code** and allows custom connectors — two scheduled routines do the reading on your subscription's usage (on Pro, reading your past year in the first days can reach the usage limit; it then just goes slower) — **or** an **Anthropic API key** with prepaid credit (pay per use; the everyday reading is capped at US$3 a day by default, and reading your past year waits for your OK on a price the ledger emails you). **Only Claude can do this reading: a ChatGPT or Codex subscription cannot** — Codex can still guide the install. · **Claude 付費方案（Pro 或 Max，要有 Routines 和自訂連接器；讀信用的是方案額度）**，或 **Anthropic API 金鑰**（用多少付多少，預設每天最多 3 美元）。**只有 Claude 能讀信，ChatGPT／Codex 方案不行**（但 Codex 可以帶你安裝）。 | Reading emails · 讀信 |
> | 📨 | **A free Resend account.** Sends the 6-digit sign-in codes for the Claude connectors and the ledger's alarm emails. · **免費 Resend 帳號**：寄登入驗證碼和警示信。 | Sign-in codes · 驗證碼 |
> | 💻 | **A Mac or Linux computer with Node.js 22.13 or newer** (and its admin password, to install Node), for the one-time setup (Windows works through WSL). · **Mac 或 Linux 電腦＋Node.js 22.13 以上**（安裝 Node 需要電腦的管理者密碼；只在安裝時用）。 | Setup · 安裝 |
> | 📄 | **Each bank's statement PDF password**, if your bank locks them (often an ID or birth date). · **每家銀行月結單 PDF 的密碼**（如果有上鎖）。 | Statements · 月結單 |
>
> **Chosen at install, no code:** your **language** (English or Traditional Chinese — the page, the alarms,
> the iPhone replies and the connector's messages), your **home currency** (SGD, EUR, USD, GBP, JPY, TWD,
> AUD… — any ISO currency with 0 or 2 decimals), your **time zone** (daylight saving included) and your
> **country**; every total is in your currency, written the way your language and country write money and
> dates ("€12.50", "12 Oct 2026"), and every day is yours. **Your banks** are a list in your accounts file — each
> bank and the mail domains it sends from — so any bank whose alerts or statements reach your Gmail can be
> read (by your Claude reader; ready-made instant readers exist for DBS/POSB, Citi Singapore and HSBC
> Singapore alerts). Foreign purchases are estimated against your currency until the statement confirms
> them. **Not yet:** languages other than English and Traditional Chinese; a home currency with 3 decimals
> (KWD, BHD…) is refused. · **安裝時自己選，不用改程式**：介面語言（英文或繁體中文）、本國幣別、時區（含日光節約）、
> 國家；你的銀行和它們的寄件網域寫在帳戶檔裡，任何寄通知信或帳單到 Gmail 的銀行都能讀。

## Install · 安裝

There is no one-click install. Instead, an AI assistant walks you through it, one step at a time
(about 1–2 hours, most of it clicking in Cloudflare, Google and claude.ai). Afterwards the ledger reads your
past 12 months of mail by itself, over a few days.
沒有一鍵安裝，改由 AI 助理一步一步帶你做（約 1–2 小時）；之後帳本會自己花幾天讀完過去 12 個月的信。

Give your AI assistant (ChatGPT, Claude, Claude Code, Codex…) the link to this repository and say:

> **Read `INSTALL.md` in this repo and walk me through installing it.**
>
> 請讀這個 repo 裡的 `INSTALL.md`，一步一步帶我安裝。

The assistant must be able to read this repository: make it public, or connect your GitHub to the
assistant, or paste the files in. (A private repository: its owner first adds your GitHub account under
**Settings → Collaborators**.) An assistant that can run commands on your computer (Claude Code, Codex)
does more of the work; one that cannot (ChatGPT in the browser) gives you each command to paste into
Terminal. Either way, **you type every password and key yourself** — never paste them into the chat.

**With Codex · 用 Codex 安裝** — use Codex **on your own computer**: the Codex CLI in Terminal, or the Codex
app on a Mac, opened in the downloaded folder. **Not a Codex cloud task**: the install signs you in through your own
browser (Cloudflare, Google), needs your iPhone, and has you type keys at hidden prompts — a cloud task can
do none of that.
請在**你自己的電腦上**用 Codex（Terminal 裡的 Codex CLI，或 Codex app），開在下載的資料夾裡；**不要用 Codex 雲端任務**。

1. On this repository's GitHub page: green **Code** button → **Download ZIP**. It unzips into Downloads as
   `ledger-kit-main`.
2. Open Terminal (⌘ + Space, type `Terminal`, Enter) and start Codex in that folder:

   ```sh
   cd ~/Downloads/ledger-kit-main
   codex
   ```

   (The Codex app: open the same folder in it instead.)
3. Tell Codex: **Read INSTALL.md and walk me through installing it.**
4. When Codex asks to run a command with internet access or outside its sandbox (`npm ci`, `npx wrangler …`,
   `npm run deploy` need the internet), approve it — or run that command yourself in a second Terminal window.
5. **The setup wizard (`bash scripts/setup.sh`) you always run yourself, in a second Terminal window**
   (⌘ + N in Terminal), never inside Codex: it opens browser sign-ins and asks for keys at hidden prompts
   that only you can type.

Already comfortable in a terminal? `bash scripts/setup.sh` is the same setup as a guided script.

## What is in here

| Path | What |
|---|---|
| `INSTALL.md` | The install guide, written for your AI assistant |
| `scripts/setup.sh` | Guided setup in the terminal (Cloudflare, database, keys, deploy) |
| `docs/` | iPhone Shortcuts, your accounts file, adding a bank, troubleshooting |
| `routines/` | The two claude.ai routine prompts (subscription mode) |
| `worker/` | The Cloudflare Worker: page, Gmail reading, PDF unlock, claude.ai connectors |
| `src/`, `migrations/` | The ledger's rules and database schema |
| `page/` | The web page (open `page/index.html?fixtures=1` to see it on made-up data) |
| `CONTRACT.md`, `AGENTS.md` | Design reference and notes for developers and coding agents |

## Privacy

Your data lives only in your Cloudflare account. Your accounts file (`seed/accounts.json`) is ignored by git.
Before publishing a copy of this repository, run `npm run check:personal-data` (see `AGENTS.md`).
