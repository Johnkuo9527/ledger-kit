-- Ledger migration 0003 — the daily engine: the work queue,
-- the alarms the owner sees, the API spend log, and Opus's alert samples.
--
-- Its own file because 0001/0002 may already be applied: D1 records migrations
-- by FILENAME, so neither is ever edited and this is never renamed.

-- ---------------------------------------------------------------- work queue
-- One Gmail message the worker still has to finish. A row is listed from a
-- Gmail search, then worked through in budgeted ticks (worker/src/tick.ts).
-- Nothing is ever dropped: a message that keeps failing ends in 'failed' with
-- an escalation, and stays here.
--
-- payload_json holds FIGURES ONLY (what the model or a pattern read out of the
-- email: amounts, dates, merchants) so a paid answer is never paid for twice.
-- Never the email's text, never the PDF, never a password.
CREATE TABLE work (
	gmail_id TEXT PRIMARY KEY,            -- the messages row is written when the message is first fetched
	source TEXT NOT NULL,                 -- 'daily' | 'backfill'
	month TEXT,                           -- 'YYYY-MM' the backfill listed it under (NULL for daily)
	kind TEXT,                            -- NULL until fetched | 'alert' | 'receipt' | 'statement' | 'unknown'
	stage TEXT NOT NULL,                  -- 'new' | 'ingest' | 'parked' | 'waiting' | 'done' | 'failed'
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer'),
	not_before TEXT,                      -- ISO timestamp: do not try again before this
	park_until_month TEXT,                -- backfill: a statement waits until the backfill reaches this month
	payload_json TEXT,
	error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX work_due ON work (stage, not_before);
CREATE INDEX work_month ON work (source, month, stage);

-- -------------------------------------------------------------------- alarms
-- Something the owner must know about, on his page and in the email. One row per
-- kind of trouble; raising it again re-opens it. Keys:
--   credit_exhausted, credit_low, key_rejected, google_signin,
--   pdf_password:<BANK>, backfill_cap, model_unavailable
CREATE TABLE alarms (
	key TEXT PRIMARY KEY,
	message TEXT NOT NULL,                -- plain English, written to the owner
	raised_at TEXT NOT NULL,
	cleared_at TEXT,                      -- NULL = still open
	notified_at TEXT                      -- when the owner was emailed about this raising
);

-- ----------------------------------------------------------------- API spend
-- What the ledger has spent on Claude, per Singapore day and model. No API
-- tells a key's remaining credit, so "credit low" is the owner's top-up figure
-- (var LEDGER_API_CREDIT_USD) minus the sum here since LEDGER_API_CREDIT_SINCE.
CREATE TABLE api_spend (
	day TEXT NOT NULL,
	model TEXT NOT NULL,
	usd REAL NOT NULL,
	calls INTEGER NOT NULL CHECK (typeof(calls) = 'integer'),
	PRIMARY KEY (day, model)
);

-- ------------------------------------------------------------ alert samples
-- The senior model's own reading of an alert from a sender that has no
-- playbook pattern yet: FIGURES only. A pattern it then writes is kept only if
-- it reproduces every sample's reading exactly (worker/src/learn.ts).
CREATE TABLE alert_samples (
	gmail_id TEXT PRIMARY KEY,
	sender TEXT NOT NULL,                 -- the From address, lower case
	reading_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX alert_samples_sender ON alert_samples (sender, created_at);

-- The weekly email lists subscriptions found since last week.
ALTER TABLE subscriptions ADD COLUMN detected_at TEXT;
