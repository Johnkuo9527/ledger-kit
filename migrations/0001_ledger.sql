-- Ledger: the owner's automatic personal ledger. Migration 0001 — the whole first schema.
--
-- Its OWN database. Never share it with another app.
--
-- Conventions every table follows (CONTRACT.md §3 says why):
--   * Money is an INTEGER count of the currency's smallest unit ("minor units"):
--     cents for SGD/EUR/USD/TWD, whole yen for JPY. CHECK(typeof(..)='integer') on
--     every money column, so a JavaScript float can never land as a REAL.
--   * Sign: POSITIVE = money leaving the owner, or a card debt growing.
--     NEGATIVE = money coming back (refund, income, a payment onto a card).
--   * Calendar dates are TEXT 'YYYY-MM-DD' in Singapore time.
--   * Timestamps are TEXT from new Date().toISOString() (always with .mmm).
--   * Ids are TEXT (crypto.randomUUID()).
--   * Enums are checked in code (src/types.ts), NOT with CHECK, on purpose:
--     SQLite cannot widen a CHECK without rebuilding the table, and these lists
--     will grow. Booleans and money types ARE checked here — those never change.
--   * Applied migrations are recorded by FILENAME. Never rename or edit this
--     file once it has been applied anywhere; add 0002_… instead.

-- ------------------------------------------------------------------ accounts
-- Every card, bank account and cash wallet the owner owns. A transfer between two
-- rows here is never spending. Seeded from seed/accounts.json (src/seed.ts).
--
-- kind decides how a statement is reconciled (src/reconcile.ts):
--   'credit_card' — its own statement; the lines must equal the statement total.
--   'debit_card'  — NO statement of its own. Its spending comes straight out of
--                   the bank account named in settles_to, so its lines are
--                   reconciled on THAT account's statement.
--   'bank'        — opening balance + movements = closing balance.
--   'cash'        — never reconciled; the owner corrects it by hand.
CREATE TABLE accounts (
	id TEXT PRIMARY KEY,
	institution TEXT NOT NULL,            -- 'dbs' | 'taishin' | 'citi' | 'hsbc' | 'cash' | …
	kind TEXT NOT NULL,                   -- 'credit_card' | 'debit_card' | 'bank' | 'cash'
	name TEXT NOT NULL,                   -- what the owner calls it, e.g. "HSBC card 5507"
	last4 TEXT,                           -- NULL for cash, or while unknown (seed TODO)
	currency TEXT NOT NULL,               -- the currency it is billed/held in: 'SGD', 'TWD'
	settles_to TEXT REFERENCES accounts (id),  -- debit_card only: the bank account it draws on
	-- 0 for 台新: it sends phone push notifications only, never email, so its
	-- lines arrive with the monthly statement (src/coverage.ts).
	alerts_expected INTEGER NOT NULL DEFAULT 1 CHECK (alerts_expected IN (0, 1)),
	has_statements INTEGER NOT NULL DEFAULT 1 CHECK (has_statements IN (0, 1)),
	active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
	created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX accounts_institution_last4 ON accounts (institution, last4) WHERE last4 IS NOT NULL;

-- The name each card carries in Apple Wallet → the account. The Apple Pay
-- shortcut reports only that name. Stored normalised (src/shortcut.ts
-- walletKey); one name can mean one account only.
CREATE TABLE account_wallet_names (
	wallet_key TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id)
);

-- ------------------------------------------------------------------ messages
-- Every Gmail message the worker has looked at, whatever it turned out to be.
-- The primary key IS the first line of dedup: a message is processed once.
CREATE TABLE messages (
	gmail_id TEXT PRIMARY KEY,
	thread_id TEXT,
	from_addr TEXT,
	subject TEXT,
	received_at TEXT NOT NULL,
	classification TEXT NOT NULL,         -- 'alert' | 'receipt' | 'statement' | 'own_summary' | 'ignored' | 'unknown'
	processed_at TEXT NOT NULL,
	error TEXT
);
CREATE INDEX messages_received ON messages (received_at);

-- ---------------------------------------------------------------- statements
-- One card or bank e-statement. A statement = one "month" for reconciliation.
CREATE TABLE statements (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	period_start TEXT NOT NULL,
	period_end TEXT NOT NULL,             -- the statement (closing) date
	currency TEXT NOT NULL,
	-- Balances in the statement's own sign: what the owner OWES on a card, what he
	-- HOLDS in a bank account. NULL when the statement does not print one.
	opening_balance_minor INTEGER CHECK (opening_balance_minor IS NULL OR typeof(opening_balance_minor) = 'integer'),
	closing_balance_minor INTEGER CHECK (closing_balance_minor IS NULL OR typeof(closing_balance_minor) = 'integer'),
	-- Net movement printed on the statement, in the ledger's sign (+ = money out
	-- / debt up). NULL → derived from the two balances.
	printed_net_minor INTEGER CHECK (printed_net_minor IS NULL OR typeof(printed_net_minor) = 'integer'),
	-- Every bank emails the statement as a password-protected PDF attachment.
	-- The PDF is read and discarded; only its figures are kept. Its password
	-- is a worker secret (LEDGER_PDF_PW_<BANK>), never stored here.
	message_id TEXT REFERENCES messages (gmail_id),
	attachment_name TEXT,
	recon_status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'reconciled' | 'escalated'
	recon_checked_at TEXT,
	recon_detail_json TEXT,               -- the ReconResult of the last check (CONTRACT.md §5.4)
	created_at TEXT NOT NULL,
	UNIQUE (account_id, period_end)
);

-- --------------------------------------------------------------------- lines
-- THE ledger. One real-world money movement = one row. Everything that proves
-- it (alert, receipt, statement line) is a row in `evidence` pointing here.
CREATE TABLE lines (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	kind TEXT NOT NULL,                   -- 'purchase' | 'refund' | 'fee' | 'rebate' | 'income' | 'transfer' | 'card_payment'
	state TEXT NOT NULL,                  -- 'open' | 'posted' | 'reconciled' | 'review' | 'void'
	txn_date TEXT NOT NULL,
	post_date TEXT,
	merchant_raw TEXT,
	merchant_key TEXT,                    -- normalised, for matching and grouping
	merchant_name TEXT,                   -- for display
	merchant_country TEXT,                -- ISO 3166 alpha-2 when known
	category TEXT,

	-- What the merchant charged.
	orig_currency TEXT NOT NULL,
	orig_minor INTEGER NOT NULL CHECK (typeof(orig_minor) = 'integer'),

	-- What the account is charged, in the account's own currency.
	bill_currency TEXT NOT NULL,
	bill_minor INTEGER NOT NULL CHECK (typeof(bill_minor) = 'integer'),
	bill_status TEXT NOT NULL,            -- 'exact' | 'estimate' | 'confirmed'
	fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (typeof(fee_minor) = 'integer'),  -- itemised overseas fee, INCLUDED in bill_minor

	-- The owner's FX rule. All NULL when orig_currency = bill_currency.
	market_rate REAL,                     -- bill-currency per 1 orig unit, on txn_date
	markup REAL,                          -- the markup the estimate used
	markup_source TEXT,                   -- 'learned' | 'bank_default'
	effective_rate REAL,                  -- bill ÷ orig, once confirmed
	observed_markup REAL,                 -- effective_rate ÷ market_rate − 1, once confirmed

	-- The figure every total uses.
	home_minor INTEGER NOT NULL CHECK (typeof(home_minor) = 'integer'),
	home_status TEXT NOT NULL,             -- 'exact' | 'estimate' | 'confirmed' | 'reference'
	home_rate REAL,                        -- reference rate used when bill_currency ≠ the home currency
	home_set_by TEXT NOT NULL DEFAULT 'rules',  -- 'rules' | 'owner'

	statement_id TEXT REFERENCES statements (id),
	refund_of TEXT REFERENCES lines (id),
	transfer_group TEXT,                  -- both legs of an own-account transfer share it
	merged_into TEXT REFERENCES lines (id),
	reimbursable_override INTEGER CHECK (reimbursable_override IS NULL OR reimbursable_override IN (0, 1)),

	flag_missed_by_alerts INTEGER NOT NULL DEFAULT 0 CHECK (flag_missed_by_alerts IN (0, 1)),
	-- An alert-only line whose statement has come and gone without it: an FX
	-- estimate never confirmed (the owner's rule), or a home-currency charge that was reversed.
	flag_not_on_statement INTEGER NOT NULL DEFAULT 0 CHECK (flag_not_on_statement IN (0, 1)),
	flag_unlinked_refund INTEGER NOT NULL DEFAULT 0 CHECK (flag_unlinked_refund IN (0, 1)),
	flag_no_rate INTEGER NOT NULL DEFAULT 0 CHECK (flag_no_rate IN (0, 1)),

	note TEXT,
	created_by TEXT NOT NULL,             -- 'rules' | 'daily' | 'senior' | 'owner'
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX lines_date ON lines (txn_date);
CREATE INDEX lines_account_date ON lines (account_id, txn_date);
CREATE INDEX lines_statement ON lines (statement_id);
CREATE INDEX lines_merchant ON lines (merchant_key, txn_date);
CREATE INDEX lines_refund_of ON lines (refund_of);
CREATE INDEX lines_open_estimates ON lines (account_id, txn_date) WHERE bill_status = 'estimate';

-- ------------------------------------------------------------------ evidence
-- Proof attached to a line. Never deleted; a line merged into another takes its
-- evidence along (UPDATE evidence SET line_id = winner).
CREATE TABLE evidence (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,                   -- 'alert' | 'apple_pay_shortcut' | 'receipt' | 'statement_line' | 'manual'
	line_id TEXT REFERENCES lines (id),   -- NULL only while unmatched / under review
	message_id TEXT REFERENCES messages (gmail_id),
	statement_id TEXT REFERENCES statements (id),
	fingerprint TEXT NOT NULL,            -- src/dedup.ts — the second line of dedup
	institution TEXT,
	last4 TEXT,
	txn_date TEXT NOT NULL,
	txn_time TEXT,                        -- 'HH:MM' when the source states it
	post_date TEXT,
	currency TEXT NOT NULL,
	amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer'),
	bill_currency TEXT,                   -- statement lines that print both
	bill_minor INTEGER CHECK (bill_minor IS NULL OR typeof(bill_minor) = 'integer'),
	merchant_raw TEXT,
	merchant_country TEXT,
	kind_hint TEXT,                       -- 'purchase' | 'refund' | 'fee' | 'fx_fee' | 'payment' | 'transfer' | 'income' | …
	details_json TEXT,                    -- order id, items, travel legs/stays (CONTRACT.md §4.2)
	created_at TEXT NOT NULL,
	UNIQUE (type, fingerprint)
);
CREATE INDEX evidence_line ON evidence (line_id);
CREATE INDEX evidence_message ON evidence (message_id);
CREATE INDEX evidence_statement ON evidence (statement_id);

-- ---------------------------------------------------------------- line_events
-- Append-only history of every change to a line: who, what, before → after.
-- Nothing ever UPDATEs or DELETEs this table.
CREATE TABLE line_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	line_id TEXT NOT NULL REFERENCES lines (id),
	at TEXT NOT NULL,
	actor TEXT NOT NULL,                  -- 'rules' | 'daily' | 'senior' | 'owner'
	event TEXT NOT NULL,                  -- the lifecycle event name, or 'edit'
	before_json TEXT,
	after_json TEXT
);
CREATE INDEX line_events_line ON line_events (line_id, at);

-- ------------------------------------------------------------------------ FX
-- Daily reference (mid-market) rates. rate = units of `quote` per 1 `currency`.
CREATE TABLE fx_rates (
	date TEXT NOT NULL,
	currency TEXT NOT NULL,
	quote TEXT NOT NULL,
	rate REAL NOT NULL CHECK (rate > 0),
	source TEXT NOT NULL,
	PRIMARY KEY (date, currency, quote)
);

-- The markup each card was last OBSERVED charging for each currency.
CREATE TABLE card_fx_markups (
	account_id TEXT NOT NULL REFERENCES accounts (id),
	currency TEXT NOT NULL,
	markup REAL NOT NULL,
	observed_txn_date TEXT NOT NULL,
	observed_line_id TEXT NOT NULL REFERENCES lines (id),
	updated_at TEXT NOT NULL,
	PRIMARY KEY (account_id, currency)
);

-- Used only until a card has a confirmed observation. Public published fee
-- levels, not the owner's data; every estimate built on one says so (markup_source).
CREATE TABLE fx_markup_defaults (
	institution TEXT PRIMARY KEY,
	markup REAL NOT NULL,
	note TEXT
);
INSERT INTO fx_markup_defaults (institution, markup, note) VALUES
	('dbs', 0.0325, 'published foreign-currency fee, unverified until a statement confirms'),
	('citi', 0.0325, 'published foreign-currency fee, unverified until a statement confirms'),
	('hsbc', 0.0325, 'published foreign-currency fee, unverified until a statement confirms'),
	('taishin', 0.015, 'published overseas fee, unverified until a statement confirms'),
	('*', 0.0325, 'fallback for any bank not listed');

-- ------------------------------------------------------------- subscriptions
CREATE TABLE subscriptions (
	id TEXT PRIMARY KEY,
	merchant_key TEXT NOT NULL,
	merchant_name TEXT,
	currency TEXT NOT NULL,
	cadence TEXT NOT NULL,                -- 'weekly' | 'monthly' | 'quarterly' | 'yearly'
	amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer'),
	previous_amount_minor INTEGER CHECK (previous_amount_minor IS NULL OR typeof(previous_amount_minor) = 'integer'),
	price_changed_on TEXT,
	first_seen TEXT NOT NULL,
	last_charged TEXT NOT NULL,
	next_renewal TEXT NOT NULL,
	occurrences INTEGER NOT NULL,
	status TEXT NOT NULL,                 -- detected: 'active' | 'lapsed'
	owner_status TEXT,                     -- NULL | 'ignored' | 'cancelled' — the owner's word beats detection
	line_ids_json TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (merchant_key, currency, cadence)
);

-- --------------------------------------------------------------------- trips
CREATE TABLE trips (
	id TEXT PRIMARY KEY,
	name TEXT,
	destination TEXT NOT NULL,            -- e.g. "Tokyo, JP"
	countries_json TEXT NOT NULL,
	start_date TEXT NOT NULL,
	end_date TEXT NOT NULL,
	status TEXT NOT NULL,                 -- 'proposed' | 'confirmed' | 'dismissed'
	evidence_ids_json TEXT NOT NULL,      -- the flight/hotel evidence that proposed it
	confirmed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX trips_dates ON trips (start_date, end_date);

CREATE TABLE trip_lines (
	trip_id TEXT NOT NULL REFERENCES trips (id),
	line_id TEXT NOT NULL REFERENCES lines (id),
	membership TEXT NOT NULL,             -- 'auto' | 'included' | 'excluded' (the owner's word beats 'auto')
	PRIMARY KEY (trip_id, line_id)
);
CREATE INDEX trip_lines_line ON trip_lines (line_id);

-- ------------------------------------------------------------ reimbursements
-- The owner states date ranges; spending inside one is company-reimbursable unless
-- he overrides that line (lines.reimbursable_override).
CREATE TABLE reimburse_ranges (
	id TEXT PRIMARY KEY,
	start_date TEXT NOT NULL,
	end_date TEXT NOT NULL,
	note TEXT,
	created_at TEXT NOT NULL,
	CHECK (start_date <= end_date)
);

-- ------------------------------------------------------------------ playbook
-- Versioned instructions. The senior model writes a new version; the daily
-- model only ever reads the head. Versions are never edited or deleted.
CREATE TABLE playbook_versions (
	version INTEGER PRIMARY KEY,
	parent_version INTEGER REFERENCES playbook_versions (version),
	author TEXT NOT NULL,                 -- 'senior' | 'owner'
	reason TEXT NOT NULL,
	body_json TEXT NOT NULL,
	body_sha256 TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE playbook_head (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	version INTEGER NOT NULL REFERENCES playbook_versions (version),
	updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- escalations
-- What the daily model hands up to the senior model.
CREATE TABLE escalations (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,                   -- 'line_unsure' | 'month_failed' | 'unknown_format' | 'match_ambiguous'
	ref_id TEXT,                          -- line id / statement id / gmail id
	reason TEXT NOT NULL,
	status TEXT NOT NULL,                 -- 'open' | 'resolved'
	resolved_by_version INTEGER REFERENCES playbook_versions (version),
	created_at TEXT NOT NULL,
	resolved_at TEXT
);
CREATE INDEX escalations_open ON escalations (status, created_at);

-- ---------------------------------------------------------------- run log
-- The honest "did the daily job run" signal. One row per cron run.
CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,                   -- 'daily' | 'backfill' | 'weekly_summary' | 'escalation'
	started_at TEXT NOT NULL,
	finished_at TEXT,
	ok INTEGER CHECK (ok IS NULL OR ok IN (0, 1)),
	counts_json TEXT,
	error TEXT
);
CREATE INDEX runs_started ON runs (kind, started_at);

CREATE TABLE sync_state (
	key TEXT PRIMARY KEY,                 -- e.g. 'gmail_history_id', 'backfill_cursor'
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
