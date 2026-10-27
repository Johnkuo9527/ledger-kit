# Words on screen — the page's buttons, and other apps' menus in Traditional Chinese

For the assistant guiding an install. INSTALL.md names every button in English. The person's screens may
show another language: give **both names** ("tap **Share** (分享)"), and when what they describe does not
match, **ask for a screenshot** before guessing. Menus move and get renamed; a screenshot settles it.

## The ledger's own page, Shortcut replies and screens

Exact: these come from the kit's catalogues (`src/words/en.ts`, `src/words/zh-Hant.ts`), so they are what the
page shows in each language (`LEDGER_LANGUAGE`).

| English (`en`) | Traditional Chinese (`zh-Hant`) |
|---|---|
| Connect Gmail | 連接 Gmail |
| Reconnect Gmail | 重新連接 Gmail |
| Gmail connected: {their address} | Gmail 已連接：{their address} |
| Gmail is not connected yet | Gmail 還沒連接 |
| Overview · Transactions · Trips · Subscriptions · To review (the five tabs) | 總覽 · 明細 · 旅行 · 訂閱 · 待確認 |
| Accounts (on Overview) | 帳戶 |
| To review → Cards · Statements · Passwords · Uploads · Card bills · Top-ups · SMS · Other | 待確認 → 卡片 · 帳單 · 密碼 · 上傳 · 繳款 · 儲值 · 簡訊 · 其他 |
| Upload statements | 上傳帳單 |
| Edit (in the category list) | 編輯 |
| Statements will not open (PDF password) — a red notice | 月結單打不開（PDF 密碼） |
| Apple Pay notification `Recorded: …` | 「已記下：…」 |
| Apple Pay notification `Held: the ledger does not know this Wallet card yet…` | 「先放著：帳本還不認得錢包裡的這張卡…」 |

The setup script (`scripts/setup.sh`) speaks English only; INSTALL.md step 5 says what each stage asks.

## Other apps in Traditional Chinese (a Taiwan-set phone or Mac)

**≈ marks the closest name we know, not a verified label** — say so to the person and ask for a screenshot if
it does not match. Unmarked names are the apps' standard Traditional Chinese labels.

### Mac

| English | 繁中 |
|---|---|
| Spotlight: ⌘ + Space, type Terminal | ⌘ + 空白鍵，輸入 Terminal 或 終端機 |
| Terminal | 終端機 |
| Applications → Utilities | 應用程式 → 工具程式 |
| Downloads (Finder sidebar) | 下載項目 |
| TextEdit | 文字編輯 |
| Format → Make Plain Text | 格式 → 製作純文字 ≈ |
| Edit → Substitutions → Smart Quotes (turn off) | 編輯 → 替代 → 智慧型引號 ≈ |
| "Terminal would like to access files in your Downloads folder" → OK | 「終端機」想要取用「下載項目」檔案夾中的檔案 → 好 ≈ |
| Input method: switch from 注音 / 倉頡 / 拼音 to **ABC** (the input menu at the top right, or Control + Space) | 輸入法切到 **ABC** |

Typing in Terminal with a Chinese input method makes full-width characters (`ｎｐｍ`, `：`) that commands do
not understand. Before every Terminal block: **ABC**.

### iPhone

| English | 繁中 |
|---|---|
| Settings → General → About (iOS version) | 設定 → 一般 → 關於本機 |
| Safari: Share → Add to Home Screen | Safari：分享 → 加入主畫面 |
| Files app · Save to Files | 檔案 App · 儲存到「檔案」 |
| Shortcuts app | 捷徑 |
| Automation tab → + (New Automation) | 自動化 → ＋（新增自動化） |
| Wallet (the automation's trigger; older iOS: Transaction) | 錢包 |
| Message (trigger) · Sender · Message Contains | 訊息 · 傳送者 ≈ · 訊息包含 ≈ |
| Run Immediately · Notify When Run (off) · Next | 立即執行 · 執行時通知 ≈ · 下一步 |
| New Blank Automation | 新增空白自動化 ≈ |
| Get Contents of URL | 取得 URL 的內容 ≈ |
| Method · Headers · Request Body · JSON · Text · File | 方法 ≈ · 標頭 ≈ · 要求本文 ≈ · JSON · 文字 · 檔案 |
| Shortcut Input · Card or Pass · Merchant · Amount | 捷徑輸入 · 卡片或票卡 ≈ · 商家 ≈ · 金額 |
| Current Date · Date Format: ISO 8601 | 目前日期 · 日期格式：ISO 8601 ≈ |
| Get Dictionary Value | 取得辭典值 |
| Show Notification | 顯示通知 |
| Shortcuts tab → + · Rename · Show in Share Sheet | 捷徑 → ＋ · 重新命名 · 在分享表單中顯示 ≈ |
| Receive Any input from Share Sheet → PDFs · Stop and Respond | 從分享表單接收任何輸入 ≈ → PDF · 停止並回覆 ≈ |

### Google (Gmail sign-in and Google Cloud console)

| English | 繁中 |
|---|---|
| "Google hasn't verified this app" → Advanced → Go to Ledger (unsafe) | 「Google 尚未驗證這個應用程式」 → 進階 → 前往「Ledger」（不安全） ≈ |
| Continue · Allow | 繼續 · 允許 |
| Project picker → New project → Create | 專案選擇器 ≈ → 新增專案 → 建立 |
| Enable (the Gmail API) | 啟用 |
| APIs & Services → OAuth consent screen | API 和服務 → OAuth 同意畫面 |
| Google Auth Platform → Branding · Audience · Data access · Clients | Google Auth Platform → 品牌 ≈ · 目標對象 ≈ · 資料存取 ≈ · 用戶端 ≈ |
| External · Publish app · In production | 外部 · 發布應用程式 ≈ · 正式版 ≈ |
| Add or remove scopes · Update · Save | 新增或移除範圍 ≈ · 更新 · 儲存 |
| Create client → Web application | 建立用戶端 ≈ → 網頁應用程式 |
| Authorised redirect URIs → Add URI | 已授權的重新導向 URI → 新增 URI |
| Client ID · Client secret | 用戶端 ID · 用戶端密鑰 ≈ |

The Google Cloud console's language follows the Google account's language. If its Chinese labels get in
the way, the person can switch that account to English for the hour (myaccount.google.com → Personal info →
Language ≈), and back afterwards.

### Cloudflare, Resend, claude.ai

These may show English whatever the computer's language. If claude.ai shows Chinese: Settings → Connectors →
Add custom connector ≈ 設定 → 連接器 → 新增自訂連接器; Routines ≈ 例行工作. Cloudflare: Workers & Pages ≈
Workers 和 Pages.
