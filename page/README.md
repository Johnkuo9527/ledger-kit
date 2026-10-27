# The ledger page

Static HTML/CSS/JS, no build step, no external files. The worker serves this folder at `/`
(`fixtures/` and `README.md` need not be served). Every word comes from `words.js`, the owner's
language's catalogue (CONTRACT §19): `say(key, vars)` — never write a sentence into `app.js`; add it to
`src/words/en.ts` and `src/words/zh-Hant.ts` under `page.` and run `npm run words`.

**Try it without a server:** open `index.html?fixtures=1` (made-up data; works from disk; English).
`&lang=zh-Hant` for Traditional Chinese; `&home=EUR&tz=Europe/Berlin&country=DE` for another home.
Add `&fail=overview,trips` to see a failed load. Rebuild fixtures:
`npx vite-node page/fixtures/make-fixtures.ts` (uses the real `src/views.ts` builders, so the
shapes are exact).

## What the page reads

Every response must be `HTTP 2xx` **and** `ok === true` (§5.1); anything else is drawn as
"couldn't load — not zero". 401 shows "locked, use your unlock link". POSTs send
`content-type: application/json` with `credentials: same-origin`.

| Route | Fields the page uses | Fixture |
| --- | --- | --- |
| `GET /api/overview?month=` | `totals`, `categories[{category,spending_home,unconfirmed_home,count}]`, `by_account[{account_id,name,…}]`, `coverage[]` | `overview.json`, `overview.2026-10.json` |
| `GET /api/lines?from&to&account&category&trip&reimbursable&q&cursor` | `lines[]`, `next_cursor`, optional **`totals`** | `lines.json` (all lines; the fixture server filters and pages by `limit`) |
| `GET /api/months` | `months[]` (MonthView) | `months.json` |
| `GET /api/trips` | `trips[]` (TripView) | `trips.json` |
| `GET /api/subscriptions` | `subscriptions[]`, `monthly_total_home`, `monthly_total_missing` | `subscriptions.json` |
| `GET /api/needs-ok` | `trips`, `held_taps`, `lines`, `months`, `other_held`, `count` | `needs-ok.json` |
| `GET /api/accounts` | `accounts[]` (AccountView) — names for coverage, months, filters | `accounts.json` |
| `GET /api/wallets` | `wallets[]` (WalletDetailView, CONTRACT §15.3) — 帳戶 → a prepaid card: balance, real value, lots, uses | `wallet.js` (`routes.wallets`) |
| `GET /api/reimbursable-ranges` | `ranges[]` | `reimbursable-ranges.json` |
| `POST /api/trips/:id/confirm` · `/reject` | `trip` | `trip-confirm.json`, `trip-reject.json` |
| `POST /api/lines/:id/reimbursable {value}` | `line` | `line-reimbursable.json` |
| `POST /api/trips {name,start_date,end_date,destination?}` | `trip`, `lines` — the owner starts his own trip (confirmed); "＋ 新增旅行" on 旅行 | built into the fixture server |
| `POST /api/trips/:id/edit {include_line_ids?, exclude_line_ids?}` | `trip`, `lines` — "加入" / "從這趟旅行移出" in a line's detail | built into the fixture server |
| `GET /api/categories[?usage=1]` · `POST /api/categories {add \| rename+to \| delete+move_to}` | `categories[]` (the owner's list), `was` (a renamed one → the name it started as: it keeps that icon), `usage` {lines, rules} — the one category picker (改分類, 現金, the 分類 filter): a bottom-sheet list, A→Z, an emoji icon per category from the page's own table (`CAT_ICON`, else the tag 🏷️), 新增 from its field; 編輯 in its head renames or deletes (a used one: count, pick where it moves, confirm) | built into the fixture server |
| `POST /api/lines/:id/category {category, scope}` | `line`, `scope` (merchant / line), `person`, `merchant_name`, `others` — `scope` "auto" remembers it for the payee unless the payee is a person | built into the fixture server |
| `POST /api/reimbursable-ranges {from,to,note}` | `count` | `reimbursable-ranges-post.json` |
| `POST /api/cash {date,amount,currency,merchant,note,category?}` | `line` (no category = the ledger decides, 自動) | `cash.json` |
| `GET /api/status` | `alarms[{key,message}]`, `gmail{ready,via,email}` — the strip above every tab (alarms, 「連接 Gmail」). Fails quietly: the strip hides, the page still works. | inline in `app.js` (`demoStatus`); `&gmail=none\|secret\|alarm\|unset` shows the other states |

## Round 2 (11 Oct 2026) — what the page now reads and sends

Fixtures for these live in `fixtures/round2.js` (hand-written, loaded after `all.js`; each part steps aside
once `all.js` carries the real shape).

| Route | What the page does |
| --- | --- |
| `GET /api/needs-ok` | Every item in every list draws its `actions[]` as buttons (`style` primary/secondary/danger). An action with `choices[]` shows tappable chips first; the pick is sent as `body[choice_key]` (default `"choice"`). A choice is `{value, label}` (also reads `id`/`label`). Optional: `choice_label` (the question above the chips), `instructions` (on the item or an action without `path` — shown as steps), `message` in the POST reply (the toast). Any extra top-level list of objects (e.g. `pdf_passwords`) gets its own tab and is drawn from `title` / `detail`. After a success it re-fetches; a failure is said plainly under the item. |
| `GET /api/subscriptions`, `POST /api/subscriptions/:id {action}` | Tabs 訂閱中 (`active`) · 可能已停止 (`lapsed`) · 已取消 (`cancelled`); 「已移除的項目」 lists `ignored`. Buttons send `active` (還在訂閱), `cancelled` (已取消), `ignore` (不是訂閱), `restore` (恢復). |
| `POST /api/lines/:id/subscription` | 明細 → open a line → 「設為訂閱」 `{value: true, cadence}` or 「不是訂閱」 `{value: false}`. Knows a line is a subscription from `line.subscription` when present, else by merchant name against the subscription list. |
| `POST /api/lines/:id/category {category, apply_to_merchant}` · `POST /api/lines/:id/kind {kind, apply_to_merchant}` | 「改分類」 and 「這筆不算花費」 (investment 投資轉帳 · loan_repayment 還款 · friend_transfer 朋友代付／換匯 · transfer 自己帳戶互轉 · card_payment 繳卡費; `purchase` = 其實是花費). Reads `changed` (lines touched) and `line` back. |
| `GET /api/lines?…&sort=amount\|date&order=desc\|asc&kind=` | Sort chips 最新 · 金額最高 · 金額最低 · 前 10 大 (top 10 is cut by the page); the page re-sorts the whole list itself, spending first. `kind=` backs the 不算花費 links. Date-range chip sends `from`/`to`. |
| `GET /api/overview?month=&group_by=merchant` | 分類 → 「商家」 reads `merchants[{merchant, spending_home, unconfirmed_home, count}]`. Optional `non_spending[{kind, total_home, count}]`; until then the page sums the month's lines (money leaving only). |
| `GET /api/payments` | 總覽 → 繳款: `cards[]` (account, last_statement, paid_since_statement, outstanding, due_date, days_left, status, unbilled) and `total {outstanding_home, minimum_due_home, unbilled_home, estimate}`. Reconciliation per card from `card.reconciliation` if present, else the `/api/months` row with the same account and `period_end = last_statement.period_to`. |
| `GET /api/accounts`, `POST /api/accounts/:id/settings {statement_day, due_day}` | Card days sheet (1–31 grid) from each 繳款 card; shows `settings_source` as 從帳單讀到 / 你設定的. |

## Asked of the routes (Dev) — all optional; the page already works with what is built

1. `GET /api/overview` could add `reimbursable_home: Money`. Until then the page sums the month's
   `GET /api/lines?…&reimbursable=true` itself (same sum as `reimbursableTotal()`); if that list
   cannot be read whole it shows "讀不到", never a guessed personal total.
2. `GET /api/lines` could add `totals: Totals` for the whole filter. Until then the page sums the
   filter itself only when every line arrived in one page (it asks `limit=100`).
3. `category=Uncategorised` should filter lines whose category is NULL (the overview's key).

Also used (Dev's added routes): `POST /api/wallet-names {name, account_id}` (name a held tap's
card from 待確認), `POST /api/reimbursable-ranges/:id/delete`, `POST /api/subscriptions/:id
{action}`, and `POST /api/lines/:id/reimbursable {value: null}` (back to the ranges).

`q` is cut to 44 UTF-8 bytes by the page (§3, §6.1).

**「連接 Gmail」** (Dev): the button is a plain link to `/google/connect` (a worker route behind the same
cookie), not a fetch — Google's consent screen needs the whole window.
