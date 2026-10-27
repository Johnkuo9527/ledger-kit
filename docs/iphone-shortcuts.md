# iPhone Shortcuts: build steps

Three automations send things from the iPhone to the ledger. They are built by hand in the
**Shortcuts** app: a ready-made `.shortcut` file cannot be shipped here, because Apple only imports
shortcut files that were signed on an Apple device, and each one must carry the owner's own address and
key anyway.

You need: the ledger's address (`ADDRESS`, e.g. `https://ledger.yourname.workers.dev`) and the
**Shortcut key** from the setup script (`LEDGER_SHORTCUT_KEY`). All three use the same key.
Buttons are named as on an **English** iPhone with iOS 17 or later; on other versions pick the closest
name. A phone in Traditional Chinese: `docs/words-on-screen.md` has each of these names in Chinese — give
both, and ask for a screenshot when a name does not match. Apple's guide:
https://support.apple.com/guide/shortcuts/welcome/ios

**The notifications are in the ledger's language** (`LEDGER_LANGUAGE`): the tables below give each one in
English and, after it, in Traditional Chinese (`zh-Hant`). The Shortcuts themselves are the same either way.

> **The Authorization header.** In every **Get Contents of URL** below, add a header with key
> `Authorization` and value `Bearer ` followed by the Shortcut key — exactly one space after `Bearer`:
> `Bearer 3f9a…`. Copy the key from your password manager on the phone; never type it into an AI chat.

## 1. Apple Pay taps → the ledger (everyone)

Each Apple Pay payment is sent to the ledger the moment it happens — this is how cards that send no
alert emails and small purchases under a bank's alert threshold get recorded.

1. **Shortcuts** → **Automation** tab → **+** (or **New Automation**).
2. Choose **Wallet** (older iOS: **Transaction**).
3. **Cards:** choose all your cards. **Categories:** leave all. Choose **Run Immediately**; turn off
   **Notify When Run** (the ledger sends its own notification). Tap **Next**.
4. Tap **New Blank Automation**.
5. Add the action **Get Contents of URL**:
   - URL: `ADDRESS/api/shortcut/tap`
   - Tap the **›** (or **Show More**) on the action. **Method:** `POST`.
   - **Headers:** **Add new header** twice: `Authorization` = `Bearer <key>`; `Content-Type` = `application/json`.
   - **Request Body:** **JSON**. **Add new field** four times, each of type **Text**:
     - `card` → tap the value, choose **Shortcut Input**, then tap it again and pick **Card or Pass**
     - `merchant` → **Shortcut Input** → **Merchant**
     - `amount` → **Shortcut Input** → **Amount**
     - `timestamp` → **Current Date**; tap it → **Date Format: ISO 8601**, and turn on **Include ISO 8601 Time**
6. Add **Get Dictionary Value**: Key `message`, Dictionary = **Contents of URL**.
7. Add **Show Notification** with the **Dictionary Value**.
8. **Done**.

**Test:** pay for something small with Apple Pay. The notification says:

| Notification (English · 繁中) | Meaning |
|---|---|
| `Recorded: …` · 「已記下：…」 | On the ledger. |
| `Already on the ledger, now with this tap: …` · 「帳本已經有這筆，這次的 Apple Pay 紀錄已經併進去：…」 | A bank email got there first; the tap joined that line. |
| `Held: the ledger does not know this Wallet card yet…` · 「先放著：帳本還不認得錢包裡的這張卡…」 | Open the page → **To review** (待確認), choose which card it is. Once per card. |
| `Already recorded` · 「已經記過了」 | The automation ran twice; counted once. |
| `not authorised` | The key is wrong: check the single space after `Bearer` and that the key is complete. |
| `the currency is unknown: send the currency field` / `… could be several currencies` | The amount had no currency mark the ledger can be sure of (a bare `$` when your home currency is not a dollar, `kr` when it is not a krona). Add a fifth JSON field `currency` (Text) = the card's currency, e.g. `EUR`, `USD`. |

## 2. A shop's SMS → its prepaid card (only if a shop texts you after each use)

Needed only for a prepaid card whose `sms` settings are in `seed/accounts.json` (`docs/accounts.md`).
Each text from the shop records the purchase and checks the balance the text states.

1. **Shortcuts** → **Automation** → **+** → **Message**.
2. **Sender:** tap **Choose** and pick the name the texts arrive under (if it is not offered, leave it
   empty). **Message Contains:** one of the wallet's `keywords`.
3. **Run Immediately**, **Notify When Run** off → **Next** → **New Blank Automation**.
4. **Get Contents of URL**:
   - URL: `ADDRESS/api/shortcut/sms`, **Method** `POST`
   - Headers: `Authorization` = `Bearer <key>`; `Content-Type` = `application/json`
   - Request Body **JSON**, two **Text** fields: `text` → **Shortcut Input** (if it offers parts of the
     message, choose **Content**); `sender` → type the wallet's `sender` exactly as in `seed/accounts.json`.
5. **Get Dictionary Value**: Key `message`, Dictionary = **Contents of URL**. Then **Show Notification**
   with the **Dictionary Value**. **Done**.

**What the notification says:** `Recorded: …` (「已記下：…」) recorded, with the balance; `Received;
reading it` (「已收到，讀取中」) a wording the ledger does not know yet — the reader reads it within the hour;
`This SMS matches no wallet that is set up; nothing recorded` (「這則簡訊沒有對到任何設定好的儲值卡，沒有記帳」)
not this wallet's text; `not authorised` the key is wrong.
To send an older text by hand, run the same request once with a third JSON field `date` = its day
(YYYY-MM-DD). The same text sent twice is recorded once.

## 3. Send to Ledger — share a statement PDF (everyone; essential for a bank that emails no statement)

Some banks (Citi Singapore, for one) email no statement; any bank's PDF can be handed over this way.

1. **Shortcuts** → **Shortcuts** tab → **+**.
2. Tap the name at the top → **Rename** → `Send to Ledger` (or `送到帳本`).
3. Tap **ⓘ** (Details) → turn on **Show in Share Sheet** → **Done**.
4. The first line reads **Receive _Any_ input from _Share Sheet_**. Tap **Any** → **Clear** → tick only
   **PDFs**. If the line offers **If there's no input**, choose **Stop and Respond**.
5. **Get Contents of URL**:
   - URL: `ADDRESS/api/statements/share`, **Method** `POST`
   - Headers: `Authorization` = `Bearer <key>`; `Content-Type` = `application/pdf`
   - **Request Body:** **File** → tap **File** → **Shortcut Input**
6. **Show Notification** with **Contents of URL** (the ledger answers in one plain sentence). **Done**.

**Use:** open a statement PDF (bank app, Mail or **Files**) → **Share** → **Send to Ledger**.
If the bank's app has no Share button, **Save to Files** first, then share it from the **Files** app.
Many PDFs at once (two years of statements) are faster from a computer: open the page → **Overview** → **Card bills**
(總覽 → 繳款) → drag them onto **Upload statements** (上傳帳單).

| Notification (English · 繁中) | Meaning |
|---|---|
| `Received; reading it` · 「已收到，讀取中」 | Received; it shows under **Card bills** within minutes (the file is deleted once read). |
| `This statement was received before` · 「這份帳單之前已經收過了」 | Sent before; counted once. |
| `Not taken: Not a PDF…` / `…over 10 MB…` · 「…不是 PDF 檔…」 / 「檔案超過 10 MB…」 | Not a statement PDF. |
| `Not allowed: the key in the Shortcut is wrong` · 「沒有授權：捷徑裡的金鑰不對」 | The key is wrong: one space after `Bearer`, key complete. |
