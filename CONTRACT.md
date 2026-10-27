# Ledger — the contract

The design reference for developers and coding agents: data model, engine rules, routes, connector tools and
the decisions behind them. Installing the ledger does not need it — see `INSTALL.md`. Section numbers are
cited from code comments (`CONTRACT §6.6`), so keep them stable.

Dated notes ("14 Oct 2026") record when a behaviour was added; "the owner" is the one person whose ledger it is.
**Sections dated before 25 Oct 2026 were written for the kit's first home** (SGD, Singapore): there, read
"SGD"/"S$" as *the home currency*, "Singapore day/time" as *the owner's day/time* and `*_sgd` as `*_home`.
§18 says how the home and the bank list are chosen.

---

## 1. Running the tests

```
npm ci && npm test
```

Node 22.13 or newer (the tests use Node's built-in SQLite, unflagged from 22.13). `npm run type-check` checks the types.
Every test uses invented accounts, merchants and amounts. No test can reach a real database: the test
database lives only in memory, and it is built from the same migration files the worker will apply.

## 2. What is where

| Path | What it holds |
| --- | --- |
| `migrations/0001_ledger.sql` | The whole schema. D1 records migrations **by filename**: never rename or edit an applied file; add the next number (`AGENTS.md` says from which commit). |
| `seed/accounts.json` | the owner's accounts. **Personal: gitignored, never committed.** Loaded by `src/seed.ts`. |
| `src/types.ts` | Row shapes (exact column names) and every enum. |
| `src/home.ts` | **The owner's home** (§18): home currency, time zone, country; the only code that turns an instant into his day or clock. |
| `src/money.ts` `src/dates.ts` | Integer money, conversion, parsing (`parseMajor` typed, `parsePrinted` any locale's print), formatting. Calendar-date arithmetic. |
| `src/bank-list.ts` | **The owner's banks** (§18): the data shape, its check, `BankList` (whose domain, does Gmail vouch, what to search). |
| `src/merchant.ts` | Merchant normalising and similarity. |
| `src/fx.ts` | the owner's FX rule and FX-fee rule. |
| `src/dedup.ts` | Fingerprints; the "never read our own weekly summary" guard. |
| `src/transfers.ts` | Kind of a line; never-spending rule; pairing transfer legs. |
| `src/matching.ts` | One purchase = one line; overseas-fee lines join their purchase. |
| `src/refunds.ts` `src/reconcile.ts` `src/coverage.ts` | Refund links; monthly reconciliation and flags; how complete each account is. |
| `src/subscriptions.ts` `src/trips.ts` `src/reimbursable.ts` | Detection and grouping. |
| `src/shortcut.ts` | The Apple Pay shortcut's request, key check and parsing. |
| `src/playbook.ts` `src/playbook-store.ts` | The playbook's shape, validation, alert patterns, versioned storage. |
| `src/engine.ts` | The rules applied to the database. **The only code that writes ledger lines.** |
| `src/views.ts` | Every JSON shape the page and the connector read. |
| `src/db.ts` | The structural D1 interface: pass `env.LEDGER_DB` straight in. |

## 3. Conventions (binding on every job)

- **Money is an integer of minor units** (`*_minor`, `home_minor`): cents for EUR/SGD/TWD/USD, whole yen for JPY
  (`exponent()` in `money.ts`). Every money column has `CHECK(typeof(x)='integer')`. Parse typed amounts with
  `parseMajor()`, printed ones (a tap, an SMS, a model's reading) with `parsePrinted()`, never `parseFloat`.
  `home_*` columns and `*_home` fields are in the **home currency** (`homeCurrency()`, §18).
- **Sign:** `+` = money leaving the owner or a card debt growing; `−` = money coming back (refund, income, a
  payment onto a card).
- **Dates** are `YYYY-MM-DD` on the owner's calendar (`localDate()` in `src/home.ts`, daylight saving
  included; a day's or month's window is `[dayStart(a), dayStart(b))`); **timestamps** are
  `new Date().toISOString()`; **ids** are `crypto.randomUUID()`.
- **Enums are checked in code, not with SQL CHECK constraints** (SQLite cannot widen a CHECK without rebuilding
  the table). The lists are in `src/types.ts`.
- **Foreign keys are on** (as in D1). Insert a `messages` row before any `evidence` or `statements` row that
  names its `gmail_id`. Insert a bank before the debit card that `settles_to` it.
- **D1 limits the tests already enforce:** at most 100 bound values per statement; `undefined` is refused.
  Also, measured on an earlier project: a `LIKE` pattern is capped at **50 UTF-8 bytes** (16 Chinese characters), so a
  merchant search must budget bytes, not characters.
- **Every write to a line goes through `engine.ts`** (`changeLine` for edits), which writes a `line_events` row
  in the same batch. `line_events` and `playbook_versions` are append-only; a test fails on any
  `UPDATE`/`DELETE` of them in `src/`.

## 4. The database

### 4.1 Tables

| Table | One row is… | Key points |
| --- | --- | --- |
| `accounts` | a card, bank account, cash, or a stored-value wallet | `kind` ∈ `credit_card` · `debit_card` · `bank` · `cash` · `wallet` (§15). `settles_to` (debit card → its bank). `alerts_expected` 0 for 台新. `has_statements` 0 for debit card and cash. |
| `account_wallet_names` | an Apple Wallet card name → account | `wallet_key` = `walletKey(name)` (case and punctuation ignored). |
| `messages` | a Gmail message looked at | PK `gmail_id` = first layer of dedup. `classification` ∈ alert · receipt · statement · own_summary · ignored · unknown. |
| `statements` | one card or bank statement = one "month" | `UNIQUE(account_id, period_end)`. Balances in the statement's own sign. `printed_net_minor` in ledger sign. `attachment_name` = the PDF it came from. `recon_status` + `recon_detail_json` (a `ReconResult`). |
| `lines` | **one real money movement** | See §4.3. |
| `evidence` | one piece of proof | `type` ∈ alert · apple_pay_shortcut · receipt · statement_line · manual. `UNIQUE(type, fingerprint)` = second layer of dedup. `line_id` NULL while held. `details_json` = `EvidenceDetails`. |
| `line_events` | one change to a line | who (`actor`), what (`event`), `before_json` → `after_json`. Append-only. |
| `fx_rates` | a daily reference rate | `rate` = `quote` per 1 `currency`. Stored X→home currency daily (`quote` = it); crosses are computed. |
| `card_fx_markups` | a card's last observed markup per currency | Learned on confirmation (§9). |
| `fx_markup_defaults` | a bank's default markup | Seeded: DBS/HSBC/Citi 3.25%, 台新 1.5%, `*` 3.25%. |
| `subscriptions` | a detected recurring charge | `UNIQUE(merchant_key, currency, cadence)`. `owner_status` beats detection. |
| `trips`, `trip_lines` | a trip, and the owner's include/exclude choices | `trip_lines.membership` ∈ auto · included · excluded. |
| `reimburse_ranges` | a date range the owner called company-reimbursable | |
| `playbook_versions`, `playbook_head` | the playbook, versioned | §7. |
| `escalations` | a case handed to the senior model (or a note for the owner) | `kind` ∈ line_unsure · match_ambiguous · month_failed · unknown_account · unknown_wallet_card · unknown_format · learned_card_number. One open case per kind + ref. |
| `runs` | one cron run | The honest "did it run" signal. Read `runs`, never assume. |
| `sync_state` | a cursor | e.g. `gmail_history_id`, `backfill_cursor`, `run_lock`. |

### 4.2 Evidence sources (what the daily engine feeds in)

| Source | How it arrives | Engine call |
| --- | --- | --- |
| **Bank alerts**: DBS, HSBC, Citi (email alerts on) | Gmail. Read by the playbook's `alert_patterns` with **no model call** (`applyAlertPattern`); an email no pattern fits goes to the daily model. | `ingestEvidence({type:'alert', institution, last4, …})` |
| **Apple Pay taps**: every card, **including 台新** | iPhone Shortcuts "Transaction" automation → `POST /api/shortcut/tap` (§6.6) | `ingestTap(body)` |
| **Receipts and invoices** | Gmail. Read by the daily model into amount, merchant, date and optional `travel` | `ingestEvidence({type:'receipt'})`. **Never creates a line on its own** (§11). |
| **Statements**: every bank, **including 台新** | Gmail, as a **password-protected PDF attachment**. Each password is a worker secret named `LEDGER_PDF_PW_<BANK>` (or `_<ACCOUNT>` when two cards at one bank differ). **Never stored in D1, the repo or the playbook**; the playbook only *names* the secret (validation refuses anything else). The PDF is read and discarded; only figures are kept. | `ingestStatement(statement, lines)`. Mark itemised overseas-fee lines `kind_hint:'fx_fee'`. |
| **Cash**, and a **card purchase no alert or tap brought** | the owner, through the connector (evidence `manual`) | `addCash()` (§6.2) |
| **The ledger's own weekly summary** | **Never evidence.** Sent with header `X-Ledger-Summary` and body marker `ledger-weekly-summary:v1` (`src/dedup.ts`). `isOwnSummary()` must be checked before anything else; it also catches forwards and replies. Exclude `from:` the summary sender in the Gmail query as well. | none |

Every import is **safe to re-run**. A finished statement returns `duplicate`. A statement or alert cut off by a
crash is *finished* on the next run, not refused.

### 4.3 A line's columns, grouped

- **What and where:** `account_id`, `kind`, `state`, `txn_date`, `post_date`, `merchant_raw` / `merchant_key` /
  `merchant_name` / `merchant_country`, `category`, `note`.
- **The merchant's amount:** `orig_currency`, `orig_minor`.
- **The account's amount:** `bill_currency` (the account's; for cash, the cash's own currency), `bill_minor`,
  `bill_status` ∈ `exact` · `estimate` · `confirmed`, `fee_minor` (the overseas fee, *already inside*
  `bill_minor`).
- **FX:** `market_rate`, `markup`, `markup_source` ∈ `learned` · `bank_default`, `effective_rate`,
  `observed_markup`.
- **The figure every total uses:** `home_minor`, `home_status` ∈ `exact` · `estimate` · `confirmed` ·
  `reference`, `home_rate`, `home_set_by` ∈ `rules` · `owner`. *Reference* = converted at the reference rate
  because the account is not in the home currency (台新 at an SGD home, foreign cash); show it as an estimate.
- **Links:** `statement_id`, `refund_of`, `transfer_group` (both legs share it), `merged_into`, `trip_lines`.
- **The owner's override:** `reimbursable_override` (NULL = follow the ranges).
- **Flags (0/1):** `flag_missed_by_alerts`, `flag_not_on_statement`, `flag_unlinked_refund`, `flag_no_rate`.

## 5. JSON the page and the connector read

Builders are in `src/views.ts`. Use them; never hand-build a second version of a shape.

### 5.1 The envelope: `ok: true` is load-bearing

Every response is `{ ok: true, …payload }` or `{ ok: false, message }`. A reader **requires** `response.ok`
**and** `body.ok === true`, and treats everything else as a failure. It never caches a failed answer, and it
never draws a failure as an empty list. (In an earlier project a Cloudflare crash page arrived as JSON with `ok`
undefined and was drawn as "no data".) Add every new read route to a test asserting `ok === true`.

**Speed (20 Oct 2026 — tabs took 3–5 s).** What a page read costs live is its number of ROUND
TRIPS to D1, one after another, not its query count: each is a hop from the worker to the database. A read
sends every query it can at once (`Promise.all`; `startViewContext` before the lines it is for) and stays
within a few round trips — `worker/test/speed.test.ts` holds each read to ≤ 4 (a trip's own lines ≤ 6) and
every answer byte-identical to before. The page remembers each successful GET: under 30 s it is used as is;
up to 10 minutes it is drawn at once and fetched again behind it (the tab redraws only if the answer changed,
never while the owner types or has a sheet open); older, the page waits. Any POST empties the memory, so a change
The owner made is never drawn from memory. A list read page by page never mixes an older page with a newer one.
The loop that measures a tab switch end to end: `worker/test/perf/tab-switch.loop.ts`.

### 5.2 `LineView`

```
{ id, date, account:{id,name,kind,institution}, kind, state,
  spending: bool,            // counts in spending totals
  provisional: bool,         // no statement has confirmed it yet, and one will (alert/tap only)
  merchant:{name,raw,country}, category,
  amount:{ original: Money, billed: Money+{status}, home: Money+{status,set_by}, overseas_fee: Money|null },
  fx: null | {market_rate, markup, markup_source, effective_rate, observed_markup},
  flags: ("missed_by_alerts"|"not_on_statement"|"unlinked_refund"|"no_rate"|"needs_review")[],
  evidence: ("alert"|"apple_pay_shortcut"|"receipt"|"statement_line"|"manual")[],   // the kinds of proof
  refund_of, transfer_group, statement_id, trip_id,
  reimbursable:{effective, source:"override"|"range"|null, range_id}, note }
Money = { currency, minor, display }    // display e.g. "SGD 1,234.50", "−SGD 3.00", "JPY 1,200"
```

### 5.3 `Totals`
`{ spending_home: Money, count, unconfirmed_home: Money, missing_rate_count }`. Spending = purchases + fees −
refunds. `unconfirmed_home` is the part still an estimate or reference figure; show it beside every total.

### 5.4 `MonthView` (a statement)
`{ statement_id, account_id, period_start, period_end, status:"pending"|"reconciled"|"escalated", checked_at,
expected: Money|null, ledger: Money, difference: Money|null, problems:[{code,message,ids?}] }`. Problem codes
are listed in `ReconCode` (`src/reconcile.ts`).

### 5.5 `TripView`, `SubscriptionView`, `WeeklySummary`
See `src/views.ts`. A trip carries `total_home` (the true cost), `unconfirmed_home` and `reimbursable_home`. A
subscription carries its latest and previous price, `price_changed_on`, `next_renewal`,
`monthly_equivalent`, and a `status` where the owner's word (`ignored`/`cancelled`) beats detection.

### 5.6 `Coverage`: never imply zero spending
`{ account_id, mode:"live"|"statement_only"|"manual", complete_through, last_statement_date, last_tap_date,
partial, message }` from `accountCoverage()`. **Every view of a period that includes a `statement_only`
account must show its `message`** whenever `partial` is true, for example *"台新 card 5510: up to date as of the
statement of 2026-03-25; after that, only Apple Pay taps"*.

**Between statements is normal, a late statement is trouble (14 Oct 2026, the owner: 「照建議改」).** A
`statement_only` card also carries `next_statement_due` (its last statement + one month, on the card's cut-off day
`statement_day` when set), `overdue` (the period's end is more than `OVERDUE_GRACE_DAYS` = 10 days past it) and,
when overdue, `overdue_reason` `{kind, since}`: `pdf_password` (a newer statement mail waits for its password;
or the bank's PDF-password alarm is open and nothing newer from its address says otherwise), `read_failed` (a newer
mail from the address its statements come from could not be read), `reading` (one arrived and is still being
read), `no_mail` (none since `since`, the last one's arrival). `partial` keeps its meaning (the period may miss spending), so nothing presents the gap as zero. The
page: `partial` and not `overdue` → a neutral grey note (「台新 9月14日 之後的消費要等下一期帳單（約 10月13日
結帳）」); `overdue` → the warning, saying what is late and why. The weekly email lists an overdue card under
"needs you".

## 6. Connector tools

All tools return the §5.1 envelope. Amounts typed by the owner are strings parsed with `parseMajor()`. Dates are
`YYYY-MM-DD`. Every write goes through `engine.ts` with `actor: 'owner'`.

Size limits (26 Oct 2026, MCP SDK advisory GHSA-46jr-4wx8-v453): each connector caps one call's array elements +
object members and its request body — `/mcp` 10,000 and 1 MiB (`LEDGER_MCP_LIMITS`, mcp.ts), `/mcp-reader` 50,000
and 4 MiB (`READER_MCP_LIMITS`, reader-mcp.ts; a long statement handed in as an object is thousands of members). A
call over the cap is an MCP error result and no tool runs; an oversized body is answered 413. A new tool whose
honest input could come near a cap raises that cap in the same change (`worker/test/mcp-limits.test.ts`).

### 6.1 `ledger_query`
In: `{ from?, to? (default: this calendar month), account_id?, kind?, category?, merchant? (text, ≤ 44 UTF-8
bytes, see §3), trip_id?, reimbursable?: bool, flags?: LineFlag[], provisional?: bool, group_by?:
"none"|"category"|"merchant"|"account"|"month", limit? (default 50, max 200) }`.
Out: `{ lines: LineView[], totals: Totals, groups?: [{key, spending_home: Money, count}], coverage: Coverage[],
truncated: bool }`.

### 6.2 `ledger_add_cash`
In, to add: `{ date, amount: "12.50", currency, merchant, category?, note?, home_amount?: "10.80" }` →
`addCash()`. Foreign cash without `home_amount` is a `reference` estimate.
With `account: "grabpay"`, `"sample-bistro"` (any wallet's id or name): spending from that wallet (§15) — in its currency (the home currency) only,
from its cut-over date; with no category, the wallet's `wallet_spend_category` when it is on the owner's list (§15.1);
joins a line Grab's own mail already made (same amount, same or next day) instead of adding one, answering
`already_recorded: true`. Below zero: recorded, flagged `needs_review` (§15.1).
With `account` = a credit or debit card (id or a piece of its name, `resolveAccount`; 台新 included) —
21 Oct 2026, an Apple Pay under Citi's alert threshold on a day the Shortcut failed: a purchase on that card that
no alert or tap brought → `addCardSpend()`. It is built exactly like a tap on that card (the card's kind rules and
The owner's payee rules, an FX estimate if foreign, provisional until the statement, `created_by: 'owner'`), with ONE
evidence row of type **`manual`** (no new evidence type, no migration; the page shows 「你手動加的」). Not
`apple_pay_shortcut`: that would tell the Shortcut's own check (§6.6) the Shortcut worked, and would stop the real
tap, if it ever came, from joining. Because the line is on the card and has no statement or alert evidence, the
card's statement line — and a late alert or tap — joins it through the ordinary matching (`src/matching.ts`), never a second
line. Before creating, the same matching runs over that card's lines of the same or next day: an alert, tap or
statement line already there is joined instead (`already_recorded: true`; his category kept as a `category`
event, his note fills an empty one); several different purchases that fit are refused with the list, nothing
added. Currency defaults to the card's own; `home_amount` is refused (the statement confirms it). After the
statement, such a line carries `missed_by_alerts` on a card that sends alerts, as a tap-only line does. A
**bank account** is refused: its lines come from its alerts and statements.
In, to correct: `{ line_id, home_amount }` → `correctHome()`. This is allowed only on cash or `reference` lines.
A card estimate is refused, because its statement confirms it.
Out: `{ line: LineView, already_recorded? }` (`already_recorded` on a wallet or card only).

### 6.3 `ledger_mark_reimbursable`
In, exactly one of: `{ range: {from, to, note?} }` · `{ remove_range_id }` · `{ line_id, reimbursable: true |
false | null }` (null clears his override) · `{ trip_id }` (adds the trip's dates as a range and marks its
bookings `true`).
Out: `{ ranges: ReimburseRange[], affected_lines: number, reimbursable_total_home: Money }`.

### 6.4 `ledger_confirm_trip`
In: `{ action: "list" }` → proposed and confirmed trips. Or `{ trip_id, action: "confirm"|"dismiss"|"restore"|"edit",
name?, start_date?, end_date?, include_line_ids?, exclude_line_ids? }`. Allowed moves are in
`TRIP_TRANSITIONS`. Include/exclude write `trip_lines` (`included`/`excluded`), which always beat `auto`.
Out: `{ trip: TripView, lines: LineView[] }` (or `{ trips: TripView[] }` for list).

### 6.5 `ledger_subscriptions`
In: `{ status?: "active"|"all", subscription_id?, action?: "ignore"|"cancelled"|"restore" }`.
Out: `{ subscriptions: SubscriptionView[], monthly_total_home: Money }`.

### 6.6 The Apple Pay endpoint (key-locked)
```
POST /api/shortcut/tap
Authorization: Bearer <LEDGER_SHORTCUT_KEY>          ← its own worker secret, ≥ 32 characters
{ "card": "<Wallet card name>", "merchant": "…", "amount": "S$4.50", "currency"?: "SGD",
  "timestamp": "2026-03-05T08:15:00+08:00" }          ← ISO 8601 with a time zone
                                                       amount: as Wallet prints it in ANY locale — "12,50 €",
                                                       "1.234,56 €", "$4.50" (a bare $ / ¥ / kr = the home
                                                       currency when it can be), "USD 12.00" (parseTapAmount)
200 {ok:true, status:"created"|"attached"|"duplicate"|"held", line_id|null}
400 {ok:false, message}        401 {ok:false, message:"not authorised"}
```
Check the key with `shortcutAuthorised()` (constant time), then call `ingestTap()`. The key is separate from the
page's unlock key, so a lost phone can be cut off without locking the owner out of his page. A tap from an unknown
Wallet name is **held and escalated, never guessed onto a card**. `retryHeldTaps()` re-tries held taps after
names are added.

## 7. The playbook

**Shape:** `Playbook` in `src/playbook.ts` contains `summary`, `own_names` (his name as it appears on
transfers), `senders` (alert / statement / receipt / ignore lists; statement entries name their
`password_secret`), `alert_patterns` (regex with named groups, at minimum `amount`), `merchant_aliases`,
`categories`, `category_rules`, `judgement_notes`, `escalate_when`.

**Storage:** `playbook_versions` (never edited) plus `playbook_head` (the version in force).
`publishPlaybook(body, parent_version, author, reason)` writes the new version **and** moves the head in one
batch, guarded on `parent_version`. A writer who started from an older head gets `conflict`, re-reads, and
retries. `validatePlaybook()` must pass first.

**Who does what:**
- **Senior model (Opus)** writes v1 after the 2-year backfill. It then writes a new version each time it
  resolves escalations (`escalations.resolved_by_version`).
- **Daily model (Sonnet)** reads `readHead()` and gets the parts of it its reading needs (`playbookFor(task,
  version, body)`, §14) as **cached instructions**. The output is byte-stable for a version, so the cache keeps hitting. The daily model never
  writes the playbook. It writes `escalations` (`line_unsure`, `unknown_format`, …), and every month that
  fails reconciliation escalates itself (`month_failed`).
- **Model identifiers live in worker configuration** (e.g. vars `LEDGER_MODEL_SENIOR`, `LEDGER_MODEL_DAILY`),
  never in code. The API key is the owner's own (`ANTHROPIC_API_KEY` secret), not his subscription.

## 8. State machines

**Line lifecycle** (`src/lifecycle.ts`: `transition()` throws on an illegal move):
`open` →(statement attaches)→ `posted` →(month reconciles)→ `reconciled`; `reconciled` →(month breaks)→
`posted`; any live state → `review` →(resolved)→ `open`/`posted`; any → `void` →(restore)→ `open`/`posted`.

**Amount** (`bill_status` / `home_status`): foreign charge on an SGD card `estimate` → `confirmed` (statement);
same currency `exact`; 台新 TWD and foreign cash `reference` → `confirmed` (only by the owner). **Provisional** =
`statement_id` is NULL on an account that has statements (alert- or tap-only).

**Statement month:** `pending` → `reconciled` | `escalated`; `escalated` → `reconciled` after the senior
model's fix and a re-check.

**Trip:** `proposed` → `confirmed` | `dismissed`; `dismissed` → `proposed`; `confirmed` stays confirmed (dates
and lines still editable). Proposals never move a confirmed or dismissed trip (`planProposals`).

**Subscription:** detected `active` | `lapsed`. The owner's `ignored` | `cancelled` overrides both.

**Escalation:** `open` → `resolved` (with the playbook version that resolved it, when there is one).

## 9. The binding rules, and where each lives

| Rule (the owner's) | Code | Proved by |
| --- | --- | --- |
| One purchase = one line; alert, tap, receipt, statement are evidence | `matchEvidence` | `matching-refunds`, `shortcut-coverage`, `engine` ("ONE purchase") |
| FX: original kept; estimate at once; statement replaces it; effective rate recorded; estimate → confirmed | `buildLine`, `confirmForeign`, `observe` | `fx`, `engine` |
| FX fee: estimate = foreign × day's rate × (1 + card's last observed markup); markup = billed ÷ (foreign × rate) − 1, updated every confirmation; bank default until then, marked | `estimateBill`, `markupFor`, `shouldLearn`, `confirmForeign` | `fx`, `engine` |
| Overseas fee belongs to the purchase | `feeTarget`, statement pass 2 | `matching-refunds`, `engine` |
| Unconfirmed after the next statement → flagged | `isNotOnStatement` | `reconcile`, `engine` |
| TWD and foreign cash at reference rate, marked estimate | `homeView` ('reference'), `correctHome` | `fx`, `engine` |
| Card bill and own transfers never spending | `classifyKind`, `isSpending`, `findTransferPair` | `dedup-transfers`, `engine` |
| Refunds link to the purchase | `findRefundOriginal` | `matching-refunds`, `engine` |
| Statement line with no alert → "missed by alerts" | `isMissedByAlerts` | `reconcile`, `engine` |
| Month equals statement to the cent: card total, bank opening + movements = closing | `reconcileStatement` | `reconcile`, `engine` |
| Subscriptions: cadence, next renewal, price change | `detectSubscriptions` | `subscriptions-trips` |
| Trips proposed from flight/hotel, confirmed by the owner | `proposeTrips`, `tripLines`, `planProposals` | `subscriptions-trips` |
| Reimbursable ranges with per-line override | `reimbursable` | `subscriptions-trips`, `engine` |
| Dedup ignores the ledger's own weekly email | `isOwnSummary` | `dedup-transfers` |
| 台新 has no email alerts: complete as of last statement | `accountCoverage` | `shortcut-coverage`, `engine` |

## 10. What the next jobs build

- **The page:** key-locked; reads only through §5 shapes and the envelope rule; shows `Coverage`
  messages; shows estimates as estimates.
- **The connector:** the five tools in §6 plus the shortcut endpoint (§6.6).
- **The worker:** creates the D1 database (`migrations_dir: "migrations"`), loads `seed/accounts.json`
  through `seedAccounts()`/`walletRows()`, and fetches daily reference rates into `fx_rates`. It runs the
  Gmail pull (one Gmail account), PDF unlock and parse, the backfill (senior model) and daily upkeep (daily
  model), and the weekly summary email via Resend (with the §4.2 header and marker).
  It must also:
  - hold `sync_state.run_lock` so two runs never overlap;
  - write a `runs` row per run;
  - re-run `retryHeldTaps()` and held receipts daily;
  - insert `messages` rows before the evidence that names them.
  - **D1 query budgets (Workers Paid allows 1,000 queries per invocation):** every page
    route and connector tool stays at **≤ 40** (`worker/test/budget.test.ts`). The cron tick and the backfill
    have ONE setting, the var `LEDGER_TICK_D1_BUDGET` (default **400**, capped at 1,000), enforced by
    `worker/src/budget.ts` `BudgetDb`: work stops before the setting, keeping 6 queries to close the tick.
    `ingestStatement(e, st, lines, { budget })` stops BETWEEN lines and answers `partial`; calling again
    resumes it (proven equal to a one-go import, `test/chunked-statement.test.ts`).
- **A statement PDF that will not open names its bill (14 Oct 2026, the owner).** One alarm per bank,
  `pdf_password:<BANK>`, whose message is rebuilt from the bills STILL locked (work `stage='waiting' AND
  error='pdf password'`), never from the last event (`worker/src/pdf-locks.ts`): a newer bill opening leaves it;
  it clears when no bill of that bank is locked. In the owner's language (§19), each bill by the month its EMAIL ARRIVED
  (「2024年9月寄來的台新帳單打不開（密碼不對）」 / "The Taishin statement that arrived in September 2024 will not open (wrong password)" — a locked PDF has no period we could read), the card when
  known, an upload by its file name; newest first, five at most then 「還有 N 期」; why per bill (noted as
  `pdf_lock` in the row's payload when locked); then 「修法：npx wrangler secret put <NAME>…」 (the bank's secret,
  and a card's `_2` for bills from before a password change) — secret names only. 待確認 → 密碼 splits it at
  「修法：」. Rebuilt when a bill locks or a waiting bill opens, and every 6 h while one is open (the net).
- **Secrets (all worker secrets, none in the repo):** `LEDGER_PDF_PW_<BANK>` (one per bank, or per account),
  `LEDGER_SHORTCUT_KEY`, `ANTHROPIC_API_KEY`, the Gmail OAuth client and refresh token, `RESEND_API_KEY`,
  plus the page's unlock and session secrets.

## 11. Choices made here that the owner may overrule

1. **A receipt alone never creates a line.** It waits for the alert, tap or statement line (order confirmations
   for cancelled orders or things paid elsewhere would otherwise count).
2. **An ATM withdrawal is a transfer to cash, not spending.** Cash counts as spending only when the owner adds it.
3. **"After the next statement"** = a statement closing at least 5 days after the purchase. It applies to
   every alert-only line, not just foreign ones, which also catches a hotel hold that was reversed.
4. **Default markups:** DBS/HSBC/Citi 3.25%, 台新 1.5% (published levels, unverified), replaced by each card's
   own figure after its first foreign statement line.
5. **A refund never teaches a card's markup.** An observed markup outside −5% to +15% is treated as a
   mis-match, not learned.
6. **Two identical alerts in the same minute** count once. If it really was two purchases, the statement brings
   the second back as "missed by alerts".
7. **PayNow to a person is spending; from a person is income;** to or from his own name, it is a transfer.
8. **A 台新 purchase in Taiwan counts as overseas** for trips. A refund belongs to the trip its purchase is in.
9. **A statement month is the card's billing cycle**, not the calendar month. Page totals by calendar month use
   the purchase date.
10. **Subscriptions** need 3 monthly, 4 weekly, 3 quarterly or 2 yearly charges at one price before they are
    called one.
11. **Assumed:** the HSBC, Citi and 台新 cards are credit cards. HSBC and Citi bill in SGD, 台新 in TWD.
12. **The DBS debit card's number** is learned from the first DBS *card* purchase or refund alert, and only
    while exactly one DBS card has no number. A transfer alert never teaches it.
13. **A card purchase on the owner's word (§6.2)** joins an existing alert/tap/statement line only on the same or
    next day (a wallet's window; the statement keeps its own 3-day window), so his word never swallows another
    day's purchase. **台新 is allowed** although it sends no alerts: the merge needs only its statement, and
    without this the only way to record such a purchase would be cash, which its statement would count twice.

## 12. Round 2 (11 Oct 2026): the owner's first-use fixes

Round 2. Migrations, all additive:
`0004_income_offsets.sql`, `0005_bills.sql`, `0006_payee_rules.sql`,
`0007_cards_and_review.sql`. Applied like every migration (`npx wrangler d1 migrations apply ledger-db --remote -c ../wrangler.toml` in `worker`).

**C. Card days.** `accounts.statement_day` / `due_day` (1–31) and `settings_source` (`owner` | `statement` |
NULL). Every card statement's closing fills them from its date and due date when the card has no newer
statement and the owner has not set them (`billAndDays` in `src/engine.ts`; a lost card's replacement too).
`POST /api/accounts/:id/settings {statement_day, due_day}` = the owner's word (`setCardDays`); both null hands the
card back to its statements. `GET /api/accounts` carries the three fields (null for non-cards) and `replaced_by`.

**D. Bills and 繳款.** A statement reading also returns `minimum_due`, `due_date`, `payments_credited` per
section and `card_last4` per line (`worker/src/schemas.ts`). Stored on `statements`: `previous_balance_minor`,
`statement_balance_minor`, `minimum_due_minor`, `payments_credited_minor`, `due_date`, `bill_group`
(`gmailId:section`), `bill_primary`. **Bill check** (`src/bills.ts`), at every card statement's closing:
previous − payments + purchases − refunds + fees/interest = statement balance, to the cent, over the bill's
printed lines (all pieces of a split bill); payments = the printed figure, else the payment lines.
`bill_check` = `ok` | `mismatch` | NULL, working in `bill_detail_json`. A mismatch is a 待確認 `months` item
(problem code `bill_mismatch`, message in Chinese). `GET /api/payments` (`src/payments.ts`): `cards[]` =
`{account, also_on_this_bill, replaces, last_statement {statement_id, period_from, period_to,
statement_balance, minimum_due, due_date, previous_balance, payments_credited}, paid_since_statement,
outstanding, due_date, days_left, status: paid|due|overdue|autopay_pending|unknown (§16), unbilled, reconciliation {status, difference,
bill}}`, most urgent first, + `total {outstanding_home, minimum_due_home, unbilled_home, estimate, missing_rate}`.
Paid since = card-side card payments after the cut-off + the bank's unpaired payments naming the card. Due
date = the bill's, else the card's due day after its cut-off.

**Ask 4 — one bill, several cards (台新).** A card section whose lines name another known card of the same bank
(`card_last4`) is split: the bill's own card first (`bill_primary` 1, the bill's figures), then a piece per
card it names — and at a bank in `ONE_BILL_BANKS` (台新) every active card. Pieces print no balances:
`printed_net` = the sum of their lines. `accounts.replaced_by` (0007): 台新 5504 → 5506; the replacement's
coverage counts the old card's statements and 繳款 shows them as one card. **Old bills:** the look back (v3,
`worker/src/upkeep.ts`) queues every pre-round-2 台新 bill and each card's newest bill (`bill_group` NULL) to be
read once more (≤ `REREAD_MAX` 40, the daily reader, never parked); `prepareReread` moves each matched printed
line, with its ledger line, onto its card's statement (event `resplit`), never adds or deletes a line, and
leaves a line the new reading missed where it was.
**Ask 4, fixed (14 Oct 2026).** Live, 台新 5506 had no lines: every line sat on 5510, because the reading
carried no card per line (台新 prints a heading per card, not the card on each line), and nothing stored keeps a
printed line's card. Now: the reader of a `ONE_BILL_BANKS` bill is told the owner's cards there (a "Ledger note" outside
the statement's markers, `oneBillNote`) and to give every line the card of the heading it sits under; sections per
card heading that print no balance of their own are folded into the bill (`foldOneBill`, same statement date and
currency, positions renumbered, the balance checked against every card's lines); card digits are read however
printed ("XXXX-XXXX-XXXX-5506", "末四碼 5506", a unique partly-hidden "*506"); a line naming a card of the bank the
ledger does not know stays on the bill's card and is escalated by its last 4. The look back v5 piece `resplit`
queues, once, every email-read one-bill bill whose lines sit on at most one card still in use (never split, or
split only onto the lost card; newest first, ≤ `REREAD_MAX`) to be read again; `prepareReread` then moves the lines.

**A. 待確認 actions.** Every needs-ok item has `actions[{id, label, method, path, body, style, choices?,
choice_key?, choice_label?}]`; lists: `trips`, `held_taps`, `lines`, `months` (escalated or bill mismatch,
not yet reviewed), `held` (alerts / statement lines with no line; `other_held` = those beyond the list),
`pdf_passwords` (with `instructions`). Routes: `POST /api/lines/:id/review {action: accept|void|link|
retry_rate|pair, category?, refund_of?, line_id?}` (`reviewLine`; accept records the flags in `lines.owner_ok`, never raised
on that line again), `POST /api/needs-ok/held/:id/dismiss` (`evidence.dismissed_at`), `POST
/api/months/:id/reviewed|recheck`, `POST /api/needs-ok/pdf/:bank/retry`. Each answers `message`.

**Payee rules (0006, refined by 0007).** A rule covers transfer lines only (PayNow / FAST / bank transfer —
`isTransferLine` in `src/payees.ts`): a card purchase is never moved by one, so a shop whose name starts like a
friend's stays spending. `payee_rules.card_lines` = 1 when the owner made the rule from a card line (or named the
merchant to the connector): it then also covers card lines with exactly that merchant name.

**Card payments by amount alone (fix, live bug of 25 Jun).** A card's "payment received" and a bank line of
exactly that amount (±5 days) with no issuer named: decided from the card's side over every bank line that
fits (`decideCardPaymentByAmount` in `src/transfers.ts`). A payee that reads as a person or shop (`readPayee`:
anything left once bank/card/issuer/transfer words and numbers are taken out — masked "TAN AH-KXXX" too;
PayNow always) is never matched; no payee beats bank words; then the nearest date. Two equally good = nothing
changed, the card's line goes to 待確認 (`state` review, event `payment_pick_needed`) with action `pair`
(`POST /api/lines/:id/review {action: "pair", line_id}` = the owner's word: that bank line becomes the card payment
and the two are paired) or `accept` (`owner_ok` `payment_pick`: never matched by amount again). A bank line whose
kind the owner set is never a candidate. **Look back v4** (`undo` piece, then `payments`; a v3-finished ledger never
re-reads statements): every `card_payment_by_amount` the rules made is checked under this rule; one it would
not make is undone (event `undo_card_payment_by_amount` on both legs) and the card's line matched afresh. A
line the owner touched is left alone. No migration.

**May overrule:** (a) a bill check uses the bill's printed payments figure when it prints one; (b) the
re-read costs one daily-model call per bill (a second, senior call only if the new reading does not add up);
(c) a 台新 card used in no month still gets an empty piece of that month's bill; (d) a line the owner accepts in
待確認 keeps that flag off for good; (e) on 繳款 a card billed on another's bill has no row of its own — it is
listed under `also_on_this_bill`.

## 13. Statement PDFs the owner uploads (12 Oct 2026)

Citi emails no statement. The owner uploads its PDFs: `POST /api/statements/upload` (page session; multipart `files`,
optional `account_id`) → `{files[{filename, status: queued|duplicate|refused, id, message}], queued, message}`;
`POST /api/statements/share` (Bearer `LEDGER_SHORTCUT_KEY`; raw PDF or multipart) → one plain-text sentence.
`GET /api/statements/uploads` → `{uploads[UploadView]}` (`src/upload-status.ts`: state queued | read | imported |
duplicate | needs_account | needs_password | failed, `message`). `GET /api/needs-ok` adds `uploads[]`
(UploadItem: `title`, `detail`, `actions` — `POST /api/statements/uploads/:id/account {account_id}`,
`…/dismiss`). Trust: the owner's session or key replaces the Gmail bank check and an unlocked PDF is accepted; the PDF's
text stays untrusted data. The file is kept only until read (≤ 14 days). The same statement (card + closing date)
is imported once, whatever file it came in. A card's first statement sets `accounts.has_statements = 1`.

## 14. Reading on the owner's Claude subscription (13 Oct 2026)

The owner's decision: no Anthropic API key; every model judgement runs on his Claude subscription through scheduled
claude.ai routines. Var `LEDGER_READER` = `"api"` (default) | `"subscription"`. In subscription mode
`worker/src/pipeline.ts readWith` (the one place every model call goes through) calls no model: it writes a
row in `reading_tasks` (migration **0009**: kind `alert_unknown | receipt | statement | learn_pattern | escalation |
summary | categorise`, tier `daily | senior`, the exact system prompt + user content + JSON schema the API call
would send, status `open → claimed → done | failed` (+ `expired`, `superseded`), attempts, a 30-minute lease) and
the unit waits as if the model were paused. A done task's answer is parsed by the same zod schema and returned to
the caller, so it takes exactly the API answer's path (unfit figures, the daily → senior ladder, sender trust,
`applyEdits` guards, the pattern `reproduces` check). Spend caps, the mail reserve and the backfill / older months /
catch-up approvals do not apply. `/mcp-reader` ("Ledger Reader" connector, same emailed-code sign-in, grant
`props.aud = "reader"` chosen from the OAuth `resource`, token audience bound to /mcp-reader): `reader_next(tier,
limit ≤ 10)`, `reader_submit(task_id, result_json)` (strict JSON-schema check; 3 wrong answers → failed → the
engine's failure path → 待確認), `reader_status()`. A reader token is refused at /mcp and a ledger token at
/mcp-reader. `GET /api/status` adds `reader {mode, open {daily, senior}, claimed, failed, oldest_open_at,
oldest_open {daily, senior}, last_submit_at, by_kind}`; alarm `reader_idle`, each tier against its own routine
(daily tasks older than 3 h — hourly routine; senior older than 14 h — 12-hourly routine; the message names the tier). Routine prompts:
`routines/reader-daily.md`, `reader-senior.md`.

**Size limits (14 Oct 2026).** Claude Code saves a tool result over 25,000 tokens to a file, which a routine limited
to the three reader tools cannot open (live: 102,542 characters for two tasks, answered never). So:
- *Instructions carry only the playbook parts each reading needs* (`worker/src/read.ts PLAYBOOK_PARTS` /
  `playbookFor`, the API path too): alert, statement = summary, own_names, the banks' alert/statement senders,
  judgement_notes, escalate_when; receipt = the same less the senders; pattern = bank senders + alert_patterns;
  escalation = all but alert_patterns and category_rules; summary = summary, own_names, categories, notes,
  escalate_when; categorise = summary, categories, the owner's own rules. Never a `password_secret`. A first line
  names what was left out. With a v115-sized playbook (~31,500 characters whole) every kind is under 8,000
  characters (alert ~3,300, receipt ~2,900, statement ~3,600, escalation ~5,800).
- *Instructions are brought up to date when claimed* (`claimTasks(…, instructionsFor)`): a task asked under an
  older playbook is served, and stored, with today's trimmed one.
- *Budget on what is returned:* `NEXT_TOKEN_BUDGET` = 19,000 ESTIMATED tokens of the exact text `reader_next`
  returns (`estimateTokens`: an ASCII character 1/3 of a token, any other — Chinese — 2): ~57,000 characters of
  English or ~9,500 of Chinese; under 25,000 real tokens even if the estimate is low by 30%. Each distinct
  instructions text counts once. The claim estimates from lengths; `nextPayload` measures the real answer and
  gives back (re-opens at once) any task that does not fit. At least one task always.
- *A task too long on its own* (a long statement, a day's escalations) comes alone, its content cut into parts of
  ~12,000 estimated tokens (at a line break where one is near, never inside a character): part 1 carries the
  instructions and schema, `"part": 1, "parts": N` and a note; `reader_next(tier, task_id, part)` returns part
  2…N (read-only, for a task still open or claimed). The cuts depend only on the task's stored text, so a part
  asked twice is the same part. No fourth tool; both routine prompts say how to fetch the parts.

## 15. Stored-value (prepaid) wallets: GrabPay, Sample Bistro, 範例 (14 Oct / 19 Oct 2026)

A GrabPay wallet, recorded from a start date with an opening balance that was already counted as spending
when it was topped up. Migration **0010_wallet.sql** (additive):
`accounts.wallet_since / wallet_opening_minor / wallet_precounted_minor / wallet_precounted_category`,
`lines.offset_of` (one live offset per purchase: partial UNIQUE index). A GrabPay account is kind `wallet`,
institution `grab`, SGD, `has_statements` 1, `alerts_expected` 0, loaded from `seed/accounts.json`.
Rules in `src/wallet.ts`, writes in `src/engine.ts` (wallet section).

- **Balance** = opening − Σ `bill_minor` of its live lines since the cut-over, offsets excluded
  (`walletStates`, one query). `Coverage` mode `wallet` (never partial; message 「GrabPay 錢包：從 2026-10-14 起記錄；
  之前的儲值已算作支出」, plus `wallet {since, balance, precounted_left, told_only}`); `AccountView.wallet` likewise.
- **Pre-counted balance (not counted twice).** The opening balance was counted as spending in the old top-ups.
  Purchases and fees on the wallet use it up first in, first out (by date, then creation); the part of each that it
  covers gets a **`wallet_offset` line**: negative, same date, in `wallet_precounted_category`, `offset_of` = the
  purchase, merchant 「儲值時已算過的錢包餘額」. `wallet_offset` is in `SPENDING_KINDS`, so every total, category and
  account sum nets it out with no other change: the drink shows +5.44 in Drinks, −5.44 in Grab/Uber, total unchanged.
  `settleWallet` works the offsets out from scratch after every wallet write (and hourly, `wallet-upkeep.ts`, the
  net under two writes at once), changing only what differs; a voided purchase gives its share back. A refund into
  the wallet counts as an ordinary refund and returns nothing to the pool (counted so far still = really spent +
  pre-counted money still in the wallet). Offsets are never matched, never on a statement, never reimbursable,
  never provisional, never flagged, and the owner cannot edit one (`OFFSET_REFUSED`) — he changes the purchase.
  `LineView.wallet` = `{precounted, offset_line_id, offset_of, message}` on both lines.
- **Top-ups** (from the cut-over only; older ones stay spending): `looksLikeTopUp` — a line naming Grab with a
  top-up word on a bank, debit or credit card; or, on a **bank** account, the bare "GRAB" (with company words) for a
  whole number of dollars. "GRAB* A-7F3K2", "GRABFOOD"… are direct payments: spending. `classifyKind` makes it a
  `transfer` with `counter_account_id` = the wallet; if no wallet leg pairs, the rules make the wallet's leg
  (event `create` `{type: wallet_topup_leg}`) and pair them. On the wallet, money in with a transfer/top-up hint is a
  transfer; when the wallet reports a top-up first, the Grab purchase of exactly that amount (±3 days, not a direct
  charge, kind not set by the owner) on his bank or card becomes it (event `wallet_topup`). The owner's word:
  `ledger_set_kind {kind: "wallet_topup", wallet, line_id}` / `POST /api/lines/:id/kind {kind: "wallet_topup", wallet}`
  (`markWalletTopUp`); the older `grabpay_topup` (no wallet) still means a GrabPay top-up. A leg the rules made whose source is gone is voided (`voidOrphanLegs`).
- **Grab's mail** (`worker/src/banks.ts WALLET_DOMAINS`: `grab.com` and its sub-domains, Gmail DMARC/DKIM pass for
  grab.com required — never a lookalike) is the source of truth for the **wallet only** (`pipeline.ts grabUnit`,
  `read.ts grabFromAnswer`; the account is named by code, never by the mail). Read as a `receipt` reading task with
  the ledger's notes above the fenced email and its own schema (`GrabSchema`): an e-receipt paid from the wallet →
  `alert` evidence on the wallet (category from the service: drinks → Drinks, food → Food, mart → Supermarket,
  ride → Grab/Uber, only when on the owner's list); paid by card or cash → an ordinary receipt (enriches only); the
  GrabPay Wallet transaction statement (daily) → a wallet statement (`ingestStatement`, lines before the cut-over
  dropped and then its balances not claimed). A locked PDF opens with `LEDGER_PDF_PW_GRAB`. Mail claiming grab.com
  that Gmail did not vouch for is an ordinary receipt and raises alarm `wallet_unverified:GRAB`. The Gmail search adds
  `from:grab.com subject:(receipt OR statement OR "top up" OR "top-up" OR transaction OR GrabPay)`.
- **Reconciliation** (`reconcileStatement` rule `wallet_balance`): opening − Σ lines = closing when both printed;
  and a printed closing must equal the ledger's own balance at the statement's last day (`wallet_balance_mismatch`).
  No balances printed: matched line by line only. A day that fails is a 待確認 `months` item with the usual actions
  (我看過了 / 現在再對一次). Not-on-statement for wallet lines uses a 1-day lag (`WALLET_LAG_DAYS`), statements being daily.

### 15.1 Any prepaid wallet (19 Oct 2026)

The owner: "The S$200 I just spent is a top-up — later purchases will be deducted from it, same as Grab." The wallet
mechanism is generic: every rule above (balance, top-up legs, pairing, offsets of a pre-counted balance, the hourly
tidy) works on any account of kind `wallet`. What differs per wallet is **data on its account row**, so a new
prepaid card is one row (a migration INSERT + one `seed/accounts.json` entry), no code:

| Column (migration **0012_prepaid_wallets.sql**, additive) | Meaning |
| --- | --- |
| `wallet_since`, `wallet_opening_minor`, `wallet_precounted_minor`, `wallet_precounted_category` | as above (0010); pre-counted 0 = nothing offset, category may be NULL |
| `wallet_topup_merchant` | the wallet's own top-up rule: a bank/debit/credit line whose merchant **contains** this text (letters and digits only, case ignored) is money into it |
| `wallet_topup_whole_dollars` | 1 = only a whole number of dollars counts (S$100, S$200); any other amount stays a purchase |
| `wallet_spend_category` | the category a purchase the owner tells takes when he names none (only if on his list) |
| `has_statements` 0 | no statements and no mail: the balance is only what the owner tells (`told_only`) |

- **GrabPay keeps its own rule in code** (institution `grab`: top-up words, "GRAB* A-…" rides, bare "GRAB" on a
  bank) and its verified mail; its row has no `wallet_topup_merchant`. `topUpWallet` asks GrabPay's rule, then each
  other active wallet's data rule; two wallets claiming one line = none (it stays a purchase). From the wallet's
  start date only; the owner's payee rule or his word on the line beats it (`withPayeeRule`, `ownerKindIds`).
- **Example: the Sample Bistro card** in `seed/accounts.example.json` (`sample-bistro`, SGD; opening 0,
  pre-counted 0; rule "SAMPLE BISTRO" + whole dollars; default category Food; `has_statements` 0,
  `alerts_expected` 0).
- **Spending from it** is the owner's word only: `ledger_add_cash {account: "sample-bistro", …}` or the page's
  「+ 現金」 tab for the wallet (`addWalletSpend`). Counted as spending once (nothing pre-counted, no offset). Its
  coverage message is 「Sample Bistro 儲值卡：餘額只算你告訴我的消費」 (any `told_only` wallet: 「<name>：餘額只算你告訴我的消費」).
- **Below zero**: a purchase the owner tells that takes a `told_only` wallet's balance under zero (GrabPay unchanged: its
  mail and daily statement keep it) is still recorded, but the line
  goes to `review` (flag `needs_review`, event `wallet_overdrawn`) with a plain note (「…餘額變成 −SGD x：可能有一筆
  儲值還沒記到…」) — he may have forgotten to tell a top-up.
- **Choosing the wallet**: `ledger_set_kind {kind: "wallet_topup"}` needs `wallet` (id or name) when the owner has more
  than one wallet — refused with the list, never guessed; a non-wallet is refused; `grabpay_topup` with another
  wallet is refused. The page's 「儲值到…」 opens one plain button per wallet. A top-up is always one line at a time
  (a payee rule could move a meal paid by card).

**May overrule:** (a) the offset sits in the old top-ups' category (Grab/Uber), dated with the purchase, so the
month of the purchase nets to zero; (b) a top-up on a bank account = whole dollars; (c) refunds into the wallet
do not refill the pre-counted pool; (d) a Grab e-receipt can set a category, the owner's rules win; (e) a prepaid
card's rule matches the merchant text anywhere in the line, whole dollars only; (f) a below-zero balance flags
the purchase, it does not refuse it.

### 15.2 Bonus credit, and a shop's SMS (19 Oct 2026, migration **0013_wallet_bonus_sms.sql**)

A shop that gives bonus credit ("pay S$200, get 240"), and a card whose shop texts after each use (RestoSuite;
deal pay 300 get 350). Decided: the balance is the **shop's credit** (it must match the shop's site); each
use takes credit at face value; the ledger records its **real cost** = credit × paid ÷ credit got.

**Two figures on every wallet line, no new line column.** `bill_minor` = the wallet's own unit, the CREDIT (balance =
opening − Σ bill_minor); `home_minor` = the MONEY. A top-up's wallet side: `bill_minor` −credit, `home_minor` −paid
(240 / 200 → −24000 / −20000). A meal: `bill_minor` (= `orig_minor`) the credit used, `home_minor` its real cost.
Without a bonus both are equal (GrabPay, every line before this) — `costWallet` then writes nothing, ever.

- **Lots, FIFO** (`src/wallet.ts planCosts`): the opening balance is a lot (cost `wallet_opening_paid_minor`, NULL =
  face), then every money-in wallet line in date order (credit −bill, cost −home). Money-out lines use the oldest lot
  first, splitting across lots; purchases and fees get the cost. A lot's cost is handed out by running total —
  round(paid × used ÷ credit) — so a used-up lot's meals add to exactly what was paid (the last use absorbs the
  cents). Credit used beyond every lot is face value until the missing top-up arrives. `tidyWallet` = orphan legs →
  `costWallet` (event `wallet_cost`; never a figure the owner set) → offsets (which use the real costs: a pre-counted
  pool is MONEY).
- **Pairing a top-up** compares the source line's money with the wallet side's `home_minor` (not its credit).
- **The owner's word**: `markWalletTopUp(line, wallet, credit?)` — connector `ledger_set_kind {kind: wallet_topup, wallet,
  line_id, credit?: "240"}`, page 「儲值到…」 → wallet → one number field 「拿到的儲值金額」 (prefilled: what was paid,
  or the shop's deal) → POST `/api/lines/:id/kind {…, credit}`. Said again on a line already a top-up: only the
  credit changes. Credit below what was paid, or above twice it (`MAX_BONUS_RATIO`), is refused (a typo). Its
  wallet side gets `owner_ok` "bonus" and a note 「付 SGD 200.00，拿到儲值金 240.00…」. No credit named: the
  wallet's deal if its row has one, else none. GrabPay asks nothing (no credit named = unchanged behaviour).
- **The rule cannot know a bonus**: a top-up the rule made on a prepaid card (not GrabPay) whose row has **no deal**
  is taken at face value and 待確認 `wallet_topups` asks 「這次儲值有送嗎？<wallet>」 — actions 「有送，記下拿到的金額」
  (an `OkAction` with `input_key` "credit", `input_label`, `input_value` = paid; the page draws one plain number
  field) and 「沒有送」 (credit null) → POST `/api/wallet-topups/:line_id/credit {credit}` (`setTopUpCredit`, either
  side's id). Answered = `owner_ok` has "bonus"; it never comes back.
- **A shop's deal as data**: `wallet_topup_deal_paid_minor` / `_credit_minor` (範例 30000 / 35000): an automatic
  top-up gets credit = round(paid × credit ÷ paid-unit), no question; the owner's word overrides it.
- `wallet_topup_merchant` may list several names, comma-separated (any one matches).
- **Connector**: `ledger_add_cash {account: <prepaid card>, amount}` — amount is the CREDIT the shop deducted; the
  line shows original = credit, home = real cost, `LineView.credit {used, cost, message}` when they differ.

**A shop's SMS** (`POST /api/shortcut/sms`, `worker/src/sms.ts`; `src/wallet-sms.ts`). Same key as the Apple Pay
Shortcut (`Authorization: Bearer LEDGER_SHORTCUT_KEY`, 401 first). Body `{text, sender?, date?}` (date YYYY-MM-DD,
not in the future; default the Singapore day it arrived). Answers `{ok, status: done|reading|duplicate|ignored,
line_id?, message}` — `message` short Chinese for the Shortcut: 「已記下：範例 儲值卡 −S$31.40（實際 SGD 26.91），
餘額 257.48」 / 「已收到，讀取中」.
- **Untrusted text.** It reaches only the ONE active wallet (not GrabPay) whose row names it: at least one word
  of `wallet_sms_keywords` (comma-separated) must appear in the text, and
  `wallet_sms_sender` (when set) must equal the request's sender (letters and digits, case ignored). None or two
  wallets = `ignored`, nothing written. Never a bank or card, never a new account.
- **Dedup**: `wallet_sms.fingerprint` = sha256(text with spaces folded | the minute); the minute before counts too.
- **Read by code first** (`parseSmsLocally`): exactly one "used" amount after a known label (消费卡值, 消費卡值,
  消费金额, 扣款, 消费, Spent, Deducted…) and exactly one balance (卡余额, 卡餘額, 余额, 餘額, Balance…), full-width
  punctuation as ASCII (NFKC) — recorded at once. Anything else waits (`state` reading) for the reading desk:
  step `walletSms` (after the work queue, only when a reader exists), task "receipt" with LEDGER NOTES naming the
  SmsSchema shape `{kind: spend|topup|other, amount_spent, balance_left, confidence, note}`, the SMS fenced; daily,
  then senior when unsure; then `failed` → 待確認 「<wallet> 的簡訊讀不懂」 (「知道了，我自己記」 → dismiss).
- **Recording** (`applySmsReading`): a spend is a wallet line (evidence type `sms`, created_by the reader or
  rules) — it joins a line the owner already told for the same credit (same or next day; `candidateFits` skips lines
  that already have an SMS), else a new line; category the wallet's default. A top-up notice or advert records
  nothing (`not_spend`). The text is blanked once read.
- **Balance check**: the ledger's balance right after this SMS (`balanceAtSms`: every move before its day, and on
  its day those in the ledger when it arrived plus its own line) vs the SMS's. Different → `check_state`
  `mismatch` → 待確認 `wallet_sms` 「<wallet> 簡訊餘額 X，帳本算出 Y」: 「用簡訊的餘額（記一筆調整）」 (POST
  `/api/wallet-sms/:id/accept`: one line by the owner — measured again — credit used: a purchase 「簡訊餘額調整」 in the
  wallet's category, costed like a meal; credit found: a `rebate` of S$0.00, i.e. free credit) or 「我自己查」
  (`/checked`, nothing changes).
- Table `wallet_sms` (id, fingerprint UNIQUE, account_id, sender, text, received_at, sms_date, state, spent_minor,
  balance_minor, line_id, ledger_balance_minor, check_state, adjust_line_id, error, updated_at).

**Worked example** (the made-up 範例 card in `test/helpers/fixtures.ts`): opening 288.88 credit, which cost
288.88 × 300 ÷ 350 = S$247.61 (`wallet_opening_paid_minor` 24761), all of it pre-counted (Food). SMS: sender
RestoSuite AND DEMO NOODLE / 範例. Top-up rule: DEMO NOODLE HOUSE, RESTOSUITE, 範例, whole dollars, deal 300 → 350.
A sample SMS using 31.40 credit → S$26.91 real cost, offset −26.91 (pre-counted), balance 257.48 = the SMS's.

**May overrule:** (a) beyond every lot is face value; (b) credit at most twice what was paid; (c) the SMS's day
is when it arrived (Singapore) unless the Shortcut sends `date`; (d) credit the SMS shows that the ledger lacks is
free credit (S$0.00) when the owner accepts it; (e) a refund into a wallet is a lot at its own figures.

### 15.3 Seeing a wallet: balance, real value, where the money went (19 Oct 2026, no migration)

The owner: "The accounts list shows GrabPay and 範例 but not Sample Bistro… I can't see any wallet's balance… if the
account shows 0 spent, where do I see that I spent this money? It looks like it never exists." **Presentation and
API shape only: no line, kind or total changes.**

- **Why Sample Bistro was missing**: 總覽 → 帳戶 (`OverviewView.by_account`) was built from the month's SPENDING
  lines only. GrabPay and 範例 each had a meal plus its offset (net S$0.00, but present); a wallet holding only a
  top-up (a transfer, never spending) had none, so it vanished. Now **every active wallet is always listed**
  (S$0.00, count 0 when it has no spending); `by_account[].kind` added. Other accounts unchanged.
- **Remaining real value** (`src/wallet.ts walkLots / remainingValue`, the same first-in-first-out walk as
  `planCosts`): Σ over lots of (paid − cost of the credit used from it, by running total). 240-for-200 with 15.74
  used → 200.00 − 13.12 = S$186.88; no bonus → equals the balance; credit used beyond every lot leaves 0.
  `WalletState.remaining_value` → `Coverage.wallet.remaining_value` and `AccountView.wallet.remaining_value`
  (SGD). `precounted_left` is the part of it already counted as spending at old top-ups.
- **`LineView.topup`** on BOTH legs of a top-up pair (money into one wallet): `{role: source|wallet, wallet, from,
  source_line_id, wallet_line_id, paid (SGD), credit, title 「儲值 <wallet>」, message 「S$200.00 → 儲值金 240.00
  （預付，用掉時才算支出）」}` (one query, only when a transfer is listed). The page folds the wallet leg into the
  source leg in its lists when both are listed; the detail shows both legs. Both stay transfers.
- **Offsets in the list**: the page folds a `wallet_offset` line under the purchase it offsets (`wallet.offset_of`)
  when both are listed, with a note under the meal (「用儲值時已算過支出的錢付的，不重複計入」). Totals and each day's
  sum are worked out from the whole list first, so they include the offset; the meal's detail shows it.
- **`GET /api/wallets`** → `{wallets: WalletDetailView[]}` (`src/queries.ts walletDetails`, 1 + 3 queries a
  wallet): `balance` (credit), `remaining_value`, `precounted_left`, `bonus`, `lots[]` (opening / topup / other:
  date, from, paid, credit, used, left, value_left, precounted), `uses[]` (newest first, at most 100; credit, real
  cost, category, `precounted` = its offset), `used {credit, cost, precounted, counted_now}`, `precounted_topups[]`
  and `story[]`. **`precounted_topups`**: card or bank purchases before the cut-over (400 days back, newest 6)
  that the wallet's own top-up rule would take — GrabPay's rule for GrabPay — i.e. the old top-ups that were
  counted as spending (they stay spending). Their dates make 「這筆儲值在 3月2日、4月30日 刷卡時已經算過支出」; none
  on file → 「<since> 以前的儲值，當時刷卡已經算過支出」.
- **Page**: 總覽 → 摘要 tile 「儲值卡：預付未用 ≈ S$X」 (Σ remaining_value, and how much was pre-counted) → 帳戶;
  帳戶 lists every wallet (餘額 credit, ≈ value) above the bars, and a wallet's bar reads S$0.00 「儲值時已算過」,
  never 「未換算」; tapping one opens `#/wallet/<id>`: balance + value, used / real cost / counted, then tabs
  消費 | 儲值 | 說明.

**May overrule:** (a) the tile counts pre-counted money too (it is still in the cards, already spent on paper);
(b) only wallets are always listed in 帳戶; (c) the old top-ups are found by the wallet's current rule.

## 16. 繳款 never says 逾期 without evidence (14 Oct 2026)

**A. A bank payment always names the card it paid.** Live, HSBC 5502's September bill showed 逾期 though a DBS
line "Other bank's card ending 5502" had paid it in full: the line was a `card_payment` with no `counter_account_id`,
HSBC sends no payment-received email (no card-side leg to pair with), and 繳款 counted a bank payment only when its
counter account IS the card. Now (no migration):
- `cardNamedIn` (`src/transfers.ts`): the ONE credit card of the owner's whose last 4 the descriptor spells out, among
  credit cards only (a debit card sharing the digits never makes it ambiguous). `classifyKind` and
  `cardPaymentTarget` use it for a bank line whose text says CARD; DBS's built-in reader (`worker/src/banks.ts
  dbsAlert`) reads "From: …A/C ending… To: …card ending NNNN" as `payment`.
- `withCardCounter`: a bank line made a `card_payment` by a payee rule, by the owner's word (`setLineKind`,
  `setPayeeRule`, the rules look back — all through `writeChanges`) or at ingestion under a payee rule gets the
  card its descriptor names when its counter is not a credit card. A counter that is a credit card is never changed.
- `paymentsView` (`src/payments.ts`): an unpaired bank `card_payment` counts for the card `paidCard` gives — its
  counter when that is a credit card, else the card the descriptor names (the safety net).
- One-time upkeep step `card_counters` (`worker/src/upkeep.ts`, state `card_counters` = `CARD_COUNTERS_VERSION` 1):
  `fillCardCounters` fills the card on every bank card bill that names exactly one of the owner's cards and lacks it
  (event `fill_card_counter`), 20 a tick until none is left. A line whose counter the owner set (pairing in 待確認) is
  never touched.

**B. Auto-debit cards, the next statement's check, and the owner's 「我已繳款」.** Migration **`0011_bill_paid.sql`**
(additive): `accounts.autopay` (1 auto-debit / 0 he pays it himself / NULL = the ledger decides),
`statements.paid_by_owner_at` (the owner said 「我已繳款」), `statements.unpaid_seen_at` (the owner saw the 待確認 item).
- **Statuses** (`GET /api/payments` `cards[].status`): `paid` · `due` · `overdue` · `autopay_pending` · `unknown`.
  New fields: `status_reason` (`no_payment_seen` | `previous_unpaid` | null), `paid_source` (`ledger` | `owner` |
  null), `autopay {on, source: owner|statement|null}`, `previous_bill {statement_id, period_to, due_date,
  statement_balance, payments_credited, verdict: paid|unpaid|unknown, reason: nothing_owed|payments_cover_it|
  balance_carried|late_fee_or_interest|no_payment_info, owner_said_paid, seen_by_owner}` (null = no bill before).
- **The rule: no 逾期 without evidence.** In order: no bill → `unknown`; the ledger saw it paid (outstanding ≤ 0)
  → `paid` (`ledger`); the newest statement shows the bill before was not paid in full and that shortfall is
  not yet paid since → `overdue` (`previous_unpaid`); the owner said paid → `paid` (`owner`); past the due date →
  `autopay_pending` for an auto-debit card, else `overdue` (`no_payment_seen`); else `due`.
  `autopay_pending` is not in the to-pay totals (the money has most likely left an account the ledger does not
  track). Page label 「自動扣繳（等下期帳單確認）」, neutral.
- **Auto-debit**: the owner's word on any card of the row (the row's own first) beats detection; detection = the
  newest bill that lists any payment lists an auto-debit one (`AUTO_DEBIT_WORDS` in `src/transfers.ts`:
  自動轉帳扣繳, 自動扣繳, AUTO DEBIT, AUTOPAY, GIRO, DIRECT DEBIT…). A bill's lines are every piece of it
  (its `bill_group`) and any statement of the row's cards closing the same day (a lost card's bill read before
  the split).
- **The next statement's check** (`judgePrevious`): the bill before is `paid` when nothing was owed or the
  new bill's `payments_credited` (else the payment lines printed on it after the old cut-off) covers the old
  balance; `unpaid` when less was credited (`balance_carried`) or a fee line reads as a late fee or interest
  (`late_fee_or_interest`: LATE, 逾期, 違約金, 滯納, 利息, 循環信用, INTEREST, FINANCE CHARGE); else `unknown`
  (never evidence). Paying less than the full balance (even the minimum) counts as `unpaid`.
- **Rows**: a card's row follows `rowOf` all the way (`finalRow`): a lost card → its replacement → the bill it
  is billed on, so a payment on the lost card 5504 counts for the bill row that carries 5506.
- **台新 split**: a payment line (direction in, `kind_hint` payment or payment words) stays on the bill's own
  card, whichever card heading it was printed under (`worker/src/read.ts statementsFromAnswer`).
- **Routes**: `POST /api/payments/:statement_id/paid {paid: true|false}` (the owner's 「我已繳款」 / take it back; stored
  on every piece of the bill) → `{card, message}`; `POST /api/payments/:statement_id/seen` (「知道了」);
  `POST /api/accounts/:id/settings {autopay: true|false|null}` (with or without the days; each key only if sent);
  `GET /api/accounts` → `autopay` (the owner's word, null = the ledger decides).
- **待確認 → `bills`** (`BillItem {id, kind, account_id, statement_id, title, detail, actions}`): `overdue`
  (no payment seen; actions 「我已繳款」, 「這張卡是自動扣繳」) and `unpaid_on_next_statement` (until seen;
  says so when the owner had said paid; action 「知道了」). Counted in `count`.
- **Connector** `ledger_bills {card?, paid?, autopay?}`: with nothing, 繳款 for every card; card alone, one row;
  `paid` / `autopay` = the owner's word on that card's row (a card name, last 4 or bank — 台新 names its one row).
- **Page**: 繳款 row 「我已繳款」 (or 「改回帳本判斷」 on the owner's own word), the previous bill's verdict when
  unpaid; card settings sheet 繳費方式: two buttons 「自動扣繳」 / 「自己繳」 (+ 「改回由帳本從帳單判斷」).

## 17. A bank's alerts can never go missing quietly (18 Oct 2026)
DBS "iBanking Alerts" (from `ibanking.alert@dbs.com`) stopped reaching the ledger after 13 Oct while Citi and HSBC
kept coming.
- **The Gmail search** (`worker/src/pull.ts`) always names every domain on the owner's bank list (§18; DBS's three
  in the example) plus the list's sender NAMES (the example's `ibanking`, `digibank`, `paylah`, `posb`, `hsbc`). `LEDGER_GMAIL_DOMAINS` and
  the playbook's learned senders ADD to the banks, never replace them. A learned sender enters `from:( … )` only if it
  is one plain domain: a model-written receipt sender like "kopi corner sg.com" (it passed `applyEdits`) used to split
  the group (Gmail reads `a OR b c OR d` as `(a OR b) AND (c OR d)`), so bank mail matched only through
  `category:purchases` or a receipt subject — DBS's "iBanking Alerts" through neither.
- **Listing is not trusting.** Classification is unchanged: only a bank domain Gmail vouches for (DMARC/DKIM) is a bank
  alert. A bank-named alert (its id, its name's words or its `sender_names` — "iBanking", "digibank", "PayLah",
  "POSB", "DBS" — in the display name or the address's own name) from any other address is a receipt and raises
  `bank_sender_unknown:<BANK>` naming the address.
- **The catch-up** (`bankRelist`, once per `RELIST_VERSION`): today's search over 13 Oct 00:00 SGT → now; mail never
  read is queued; read mail is skipped by the insert.
- **A bank gone quiet** (`worker/src/silence.ts`, at most every 3 h, one query): an `alerts_expected = 1` bank whose last
  alert EMAIL arrived 3+ days ago while another bank's alert or an Apple Pay tap arrived in those 3 days raises
  `alerts_silent:<BANK>` 「DBS 已經 N 天沒有寄交易通知 email 來了 — 請確認 DBS app 的 email 通知，或告訴我們寄件人換了」
  (N in Singapore calendar days). Cleared when that bank's authenticated alert is read. A bank never heard from at all
  does not raise it; nor while Gmail is signed out or unchecked.
- **A DBS payment the owner wrote down by hand as cash** (`src/engine.ts absorbHandLine`): when a new DBS purchase line (alert
  or statement, SGD, money out) is made, one hand-made cash line (`created_by = 'owner'`) of exactly that amount on the
  same day whose merchant or note names PayNow / PayLah / DBS / POSB is voided with `merged_into` = the DBS line, its
  evidence moves along, and its category becomes the DBS line's (as the owner's `category` event). Never a payee the owner's rule
  calls something else, never his own money moving.

## 18. The owner's home and his banks, chosen at install (25 Oct 2026)

The kit began as one Singapore owner's ledger. Two things that were code are now his install's choice.

**The home** (`src/home.ts`, one module): `LEDGER_HOME_CURRENCY` (ISO 4217; 0 or 2 decimals — a 3-decimal
home such as KWD is refused), `LEDGER_TIMEZONE` (IANA) and `LEDGER_HOME_COUNTRY` (ISO 3166 alpha-2), in
`wrangler.toml [vars]`, written by `scripts/setup.sh` stage 3 (checked by `scripts/check-home.ts`, the same
`homeProblems` the worker uses).
- Every worker entry (page, `/mcp`, `/mcp-reader`, the tap and SMS routes, the tick) calls `useHome(env)`
  first; a missing or invalid home answers **503** with what to set, and the tick does nothing. Never a
  silent default. The tests start from SGD/Asia/Singapore/SG (`test/helpers/home-default.ts`).
- **Currency:** `homeCurrency()` / `homeMoney()` everywhere a total is made; `home_*` columns, `*_home`
  fields; the connector's instructions and tool texts name it. FX rates are fetched and stored against it:
  the ECB (Frankfurter, `base=<home>`) when it publishes the home currency (`ECB_CURRENCIES`), else every
  rate from the fallback feed's `<home>.json` page; the home currency is never in the list of currencies
  that get rates. **For good:** the first tick that does work records it (`sync_state.home_currency`); a
  different `LEDGER_HOME_CURRENCY` later stops the tick with alarm `home_changed` until it is put back
  (amounts would be relabelled, not converted).
- **Days:** `localDate`, `localTime`, `localHour`, `localWeekday`, `dayStart(date)` (the first instant of
  a local day, also when midnight was skipped), `localClockText` for alarm wording. Every "today", month
  window (the dry run, the weekly email), daily phase hour, receipt-limit midnight, tap date/time and SMS
  date uses them. Proved across both 2026 Berlin clock changes, New York's, Tokyo's New Year, and
  São Paulo's skipped midnight (`test/home.test.ts`).
- **Country:** where "abroad" starts — trips (`isOverseas`) and the overseas-fee rule for a home-currency
  card (`isForeign`).
- **The page** is told the home in `<meta name="ledger-home">` (`worker/src/page.ts homeMeta`, no inline
  script); `page/app.js` reads it for its currency, "today" and its language (§19).
- **Printed amounts** (`parsePrinted`): "12,50", "1.234,56", "1 234,56" (any space), "1'234.50",
  "1,23,456.00"; the last of `.`/`,` is the decimal point when both appear; a lone separator before
  exactly three digits groups thousands (except in a 3-decimal currency). Taps (`parseTapAmount`) also take
  the currency mark before or after; `$`, `¥`, `kr` mean the home currency when they can (else `¥` = JPY,
  else refused); a mark and a `currency` field that disagree are refused.

**The banks** (`src/bank-list.ts`): `seed/accounts.json` `"banks"`: `[{ institution, name, domains[],
sender_names?, pdf_password? }]`, checked by `seed:sql` (plain domains, never a public mailbox, never one
domain for two banks; a bank/card account whose bank is unlisted must say `alerts_expected: false`), written
by the seed SQL into `sync_state['banks']` (REPLACING the stored list), read every tick as
`Tick.banks()` (no extra query).
- **Trust is unchanged in kind:** a mail is a bank's only when its From domain is on the list AND Gmail's
  topmost Authentication-Results (mx.google.com) shows DMARC/DKIM pass for a domain of that same bank
  (`BankList.authenticated`). An empty list trusts nothing (alarm `no_banks`).
- **The bank of an alert is the vouched-for sender's**, never the model's say (`alertFromAnswer`'s
  `trustedInstitution`); a statement from mail likewise (`statementsFromAnswer`). A learned alert pattern
  is filed under the sender's bank on the list (`learn.ts`).
- **Built-in readers** (`worker/src/banks.ts`: DBS, Citi, HSBC alert formats; 台新's one-bill split) are
  examples, used only for an institution listed under that id.
- `pdf_password: false`: this bank sends its statements unlocked; by default an unlocked statement PDF is
  refused. Passwords stay `LEDGER_PDF_PW_<INSTITUTION>` secrets.
- Proved end to end with a made-up UK bank at a GBP home (`worker/test/foreign-bank.test.ts`).

## 19. The owner's language, chosen at install (25 Oct 2026)

`LEDGER_LANGUAGE` in `wrangler.toml [vars]`: **`en`** (English, the kit's default when unset) or **`zh-Hant`**
(Traditional Chinese, the wording the kit was first written in, kept exactly). Written by `scripts/setup.sh`
stage 3 (checked by `scripts/check-home.ts`); any other value answers **503** at every door like a missing
home. It can be changed later; notes the ledger already wrote stay in the language they were written in.

**One module, `src/words.ts`**, set at every entry with the home (`worker/src/env.ts useHome`):
- `say(key, vars)` — every sentence the owner reads comes from ONE catalogue per language,
  `src/words/en.ts` and `src/words/zh-Hant.ts` (flat keys; `{name}` blanks; `{ one, other }` forms picked by
  `n` through `Intl.PluralRules`). zh-Hant is typed by en's keys, so a key missing from either fails the
  type-check; `test/words.test.ts` also checks both have the same blanks and that English holds no Chinese.
  Callers never branch on the language: a per-language rule lives in `words.ts` (`inline` — Chinese spaces
  a Latin name; `sayList`'s separator is a catalogue entry).
- `sayMoney(minor, currency)` — Intl.NumberFormat in the owner's locale (`<language>-<home country>`: en-SG,
  en-DE, zh-Hant-SG), from an exact decimal string (never a float): "€12.50", "¥1,200", "US$4.50", "−€3.00".
  The home currency shows the locale's symbol, or its narrow one where the locale would spell the code
  ("$4.50" for SGD in en-SG and zh-Hant-SG); a foreign currency whose symbol would look like the home's
  takes the English one, else its code (TWD under zh-Hant-SG: "NT$300.00"). `Money.display` (the
  connector's "SGD 1,234.50") is unchanged: an ISO code reads the same in every language.
- `sayDate` / `sayDayMonth` / `sayMonth` — Intl.DateTimeFormat: "12 Oct 2026" / "2026年10月12日".
- `currencyName(code)` — Intl.DisplayNames: the word that replaced 新幣 ("Singapore Dollar", "新加坡幣").

**Reaches the owner, so follows the language:** the page (every label, toast, chart text), alarms
(`alerts_silent`, `pdf_password`, `google_signin`), coverage messages, `needs-ok` titles, details,
instructions and action labels, the wallet story, upload states, the page's POST replies, the iPhone
Shortcut replies (tap, SMS, share), the Gmail screens, and the connector's instructions where they name a
page tab. **Is data, never translated:** merchant names, statement lines, a shop's SMS, account, category,
trip and wallet names the owner typed, notes he wrote, file names. Notes and merchant names the ledger
itself writes onto a line (a top-up leg, an automatic offset, an SMS adjustment) are written in the
language of the day they are made, and nothing ever matches on their words.

**The starting categories follow the language** (25 Oct 2026, the install rehearsal). A category's name is
data — shown as written, never translated — so a zh-Hant owner starts with a Chinese list, not an English one
he could never see translated. Both lists are catalogue entries (`categories.default`); `scripts/setup.sh`
stage 3 writes the owner's into `LEDGER_CATEGORIES` while it is still a shipped list. The code that looks for
a starting name knows both: Grab's services (`read.ts` `GRAB_CATEGORY`: Food/餐飲, Drinks/飲料,
Supermarket/超市, Grab/Uber), the catch-all for a merchant the reader left out (`categorise.ts`: Others/其他),
the page's icons (`CAT_ICON`). Pinned by `test/default-categories.test.ts`.

**Field names are language-neutral** (they were `*_zh`): `title`, `detail`, `message`, `label`,
`choice_label`, `input_label`, `instructions`, `story`; a wallet's opening sentence is `opening_story`.

**The page** loads `words.js` before `app.js`: the worker serves it from the catalogues, the owner's
language only (`worker/src/page.ts`); `page/words.js` (`npm run words`, checked by `test/words.test.ts`) holds
every language for the demo opened from disk. `say(key, vars)` in `app.js` fills exactly as the server does;
`index.html` carries English and `data-say*` attributes the page fills at boot. Built-in category keys
(`dining`, `rent` …) have a word in each language; the owner's own categories show as he typed them; icons are
keyed by the category's name or key, never its shown word. Dates use Intl in the owner's locale (Chinese keeps
its own day-range shape, 「10月1日–5日」; other languages use `formatRange`).

**The demo** (`?fixtures=1`) follows `&lang=` (default English); its made-up data is generated in both
languages (`page/fixtures/make-fixtures.ts`), merchants neutral; `&home=EUR&tz=Europe/Berlin&country=DE` tells
the same made-up figures in another home currency (relabelled, never converted).

**Proved:** `worker/test/english.test.ts` — an English owner's every page read, alarm, page/Shortcut reply and
connector answer holds no Chinese character except the Chinese DATA the test seeded (allow-listed by field
and value), and that data is still there untranslated.
