-- (19 Oct 2026): prepaid bonus credit, and a shop's SMS after each use.
-- Additive only: no column dropped, no row deleted, every new column NULL and
-- one new table, so everything already in the database reads exactly as before.
-- Applied together with 0012 (neither was live before this). CONTRACT.md §15.2.
--
-- 1. Bonus credit ("pay S$200, get 240") needs NO new column: a wallet's lines
--    already carry two figures. bill_minor is the wallet's own unit — the
--    shop's CREDIT, so the balance (opening − Σ bill_minor) matches the shop's
--    site — and home_minor is the money: a top-up's wallet side holds −credit in
--    bill_minor and −paid in home_minor; a meal holds the credit it used in
--    bill_minor and its REAL cost in home_minor (src/wallet.ts planCosts, first
--    in first out across top-ups, the last use of a top-up absorbing the cents).
--    A top-up without a bonus has both equal — GrabPay, and every line so far.

-- 2. A shop that texts the owner after each use (the second restaurant): which SMS
--    belongs to which wallet, as data on the wallet's row — like its top-up
--    rule (0012). The text of an SMS can only ever touch the ONE wallet whose
--    words it carries; never a bank or card, never a new account.
--    wallet_sms_keywords: words the SMS contains (comma-separated; any one
--    matches, letters and digits only, case ignored). wallet_sms_sender: the
--    sender as the owner's Shortcut sends it ("sender" in the request), when set it
--    must match too. Both NULL = the wallet takes no SMS (GrabPay, Sample Bistro).
--    When both are set, BOTH must match (a sender like RestoSuite texts for many shops).
ALTER TABLE accounts ADD COLUMN wallet_sms_keywords TEXT;
ALTER TABLE accounts ADD COLUMN wallet_sms_sender TEXT;

-- Each SMS the Shortcut sent (POST /api/shortcut/sms), once: the same text
-- sent twice within a minute is the same SMS (fingerprint = its hash and the
-- minute). Read by the reading desk like any email (worker/src/sms.ts), then
-- the wallet spend is recorded and the balance the SMS states is checked
-- against the ledger's. The text is blanked once it has been read.
CREATE TABLE wallet_sms (
	id TEXT PRIMARY KEY,
	fingerprint TEXT NOT NULL UNIQUE,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	sender TEXT,
	text TEXT NOT NULL,
	received_at TEXT NOT NULL,
	-- The day of the use: the Shortcut's "date" when it sent one, else the Singapore day it arrived.
	sms_date TEXT NOT NULL,
	-- 'reading' (waiting for the reader) | 'done' (a spend recorded) |
	-- 'not_spend' (a top-up notice, an advert: nothing recorded) |
	-- 'failed' (could not be read: 待確認) | 'dismissed' (the owner: I'll record it myself)
	state TEXT NOT NULL CHECK (state IN ('reading', 'done', 'not_spend', 'failed', 'dismissed')),
	spent_minor INTEGER CHECK (spent_minor IS NULL OR typeof(spent_minor) = 'integer'),
	balance_minor INTEGER CHECK (balance_minor IS NULL OR typeof(balance_minor) = 'integer'),
	line_id TEXT REFERENCES lines (id),
	-- The ledger's own balance right after this SMS's spend, and what the check found:
	-- 'ok' | 'mismatch' (待確認) | 'accepted' (an adjustment line was made) | 'checked' (the owner looks himself)
	ledger_balance_minor INTEGER CHECK (ledger_balance_minor IS NULL OR typeof(ledger_balance_minor) = 'integer'),
	check_state TEXT CHECK (check_state IS NULL OR check_state IN ('ok', 'mismatch', 'accepted', 'checked')),
	adjust_line_id TEXT REFERENCES lines (id),
	error TEXT,
	updated_at TEXT NOT NULL
);
CREATE INDEX wallet_sms_state ON wallet_sms (state, received_at);
CREATE INDEX wallet_sms_check ON wallet_sms (check_state);

-- 3. A shop's bonus, as data on the wallet's row:
--    wallet_opening_paid_minor — what the owner paid for the OPENING credit (NULL =
--    the opening balance itself, no bonus): the opening lot's ratio.
--    wallet_topup_deal_paid_minor / _credit_minor — the shop's usual deal
--    ("pay 300, get 350" = 30000 / 35000): the credit an AUTOMATIC top-up is
--    given by default, in proportion to what was paid. NULL = no deal known:
--    the automatic top-up is taken at face value and 待確認 asks
--    「這次儲值有送嗎？」. The owner's own word on a top-up always wins.
ALTER TABLE accounts ADD COLUMN wallet_opening_paid_minor INTEGER CHECK (wallet_opening_paid_minor IS NULL OR (typeof(wallet_opening_paid_minor) = 'integer' AND wallet_opening_paid_minor >= 0));
ALTER TABLE accounts ADD COLUMN wallet_topup_deal_paid_minor INTEGER CHECK (wallet_topup_deal_paid_minor IS NULL OR (typeof(wallet_topup_deal_paid_minor) = 'integer' AND wallet_topup_deal_paid_minor > 0));
ALTER TABLE accounts ADD COLUMN wallet_topup_deal_credit_minor INTEGER CHECK (wallet_topup_deal_credit_minor IS NULL OR (typeof(wallet_topup_deal_credit_minor) = 'integer' AND wallet_topup_deal_credit_minor > 0));

-- A shop whose SMS should reach its wallet is set in seed/accounts.json
-- (wallet.sms: the words the SMS carries and the sender name). docs/accounts.md
-- has the recipe.
