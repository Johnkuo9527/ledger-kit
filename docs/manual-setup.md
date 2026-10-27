# Manual setup (when `scripts/setup.sh` cannot run)

The same steps as the setup script, one command at a time. Run each from the **`worker`** folder: give
every block with its own `cd <the kit's folder>/worker` first (INSTALL.md writes them that way).
Every `wrangler secret put` asks for the value with a hidden prompt: the person types it there, and
nothing appears while they type.

1. **Sign in to Cloudflare** (a browser window opens; press **Allow**):

   ```sh
   npx wrangler login
   ```

2. **Create the database and the sign-in store.** If wrangler offers to add them to your config, answer no.

   ```sh
   npx wrangler d1 create ledger-db
   npx wrangler kv namespace create LEDGER_OAUTH
   ```

   Copy the database id (`database_id = "…"` / `uuid`) into `wrangler.toml` in place of
   `REPLACE-WITH-YOUR-D1-DATABASE-ID`, and the namespace `id` in place of `REPLACE-WITH-YOUR-KV-NAMESPACE-ID`.
   Lost them? `npx wrangler d1 list` and `npx wrangler kv namespace list` show them again.

3. **Choose the reader and your home**: in `wrangler.toml`, `LEDGER_READER = "subscription"` or `"api"`, and
   replace the three `REPLACE-WITH-YOUR-…` home values: `LEDGER_HOME_CURRENCY` (e.g. `"EUR"`), `LEDGER_TIMEZONE`
   (e.g. `"Europe/Berlin"`), `LEDGER_HOME_COUNTRY` (e.g. `"DE"`); and `LEDGER_LANGUAGE`, `"en"` (English) or
   `"zh-Hant"` (Traditional Chinese). Check them from the main folder:
   `npx vite-node scripts/check-home.ts EUR Europe/Berlin DE en` prints nothing when they are right.
   For `zh-Hant`, also replace `LEDGER_CATEGORIES` with the Traditional Chinese starting list:
   `"餐飲, 超市, 飲料, 交通, Grab/Uber, 購物, 服飾, 娛樂, 訂閱, 醫療, 保險, 房租, 水電, 禮物, 旅行, 其他"`.

4. **Tables, then your banks and accounts** (`docs/accounts.md`, `docs/adding-a-bank.md`; `npm run seed:sql` runs in the main folder):

   ```sh
   npx wrangler d1 migrations apply ledger-db --remote -c ../wrangler.toml
   npx wrangler d1 execute ledger-db --remote -c ../wrangler.toml --file ../seed/accounts.sql
   ```

   Check: `npx wrangler d1 execute ledger-db --remote -c ../wrangler.toml --command "SELECT id, kind FROM accounts"`.

5. **Deploy.** Note the `https://ledger.<name>.workers.dev` address it prints (`ADDRESS`). On a new
   account it first asks to register a workers.dev subdomain: **y**, then a short name. Run it straight in
   Terminal — piped into another command (`| tee`), wrangler answers that question "no" by itself and stops.

   ```sh
   npm run deploy
   ```

6. **Three random keys.** Make each with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and set it; keep #1 and #3
   in a password manager, never in a chat.

   ```sh
   npx wrangler secret put LEDGER_UNLOCK_KEY -c ../wrangler.toml       # key 1: the page link is ADDRESS/unlock?key=<key 1>
   npx wrangler secret put LEDGER_SESSION_SECRET -c ../wrangler.toml   # key 2: nobody types it again
   npx wrangler secret put LEDGER_SHORTCUT_KEY -c ../wrangler.toml     # key 3: goes in the iPhone Shortcuts
   ```

7. **The other secrets** (INSTALL.md steps 5 and 6 say where each comes from):

   ```sh
   npx wrangler secret put LEDGER_OWNER_EMAIL -c ../wrangler.toml      # the address your Resend account uses — hidden: type it slowly
   npx wrangler secret put RESEND_API_KEY -c ../wrangler.toml
   npx wrangler secret put GMAIL_CLIENT_ID -c ../wrangler.toml
   npx wrangler secret put GMAIL_CLIENT_SECRET -c ../wrangler.toml
   npx wrangler secret put ANTHROPIC_API_KEY -c ../wrangler.toml       # api mode only
   npx wrangler secret put LEDGER_PDF_PW_HSBC -c ../wrangler.toml      # one per bank with locked PDFs: LEDGER_PDF_PW_<its id in capitals>
   ```

8. **Check:** `npx wrangler secret list -c ../wrangler.toml` lists every name above that applies.
   Then continue with INSTALL.md step 7.
