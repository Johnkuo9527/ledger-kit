-- (12 Oct 2026): statement PDFs the owner uploads himself — Citi emails no
-- statement, so he downloads them from the Citi app or web banking and hands
-- them to the ledger (POST /api/statements/upload from the page, or
-- /api/statements/share from an iPhone Share-Sheet Shortcut). Additive only.
--
-- An upload is queued in `work` like an email (gmail_id = the upload's id,
-- source 'owner_upload'), read in the cron like every statement, and imported
-- through the same engine — which already imports a card's statement for one
-- closing date once (statements UNIQUE (account_id, period_end)).

-- One row per distinct FILE (the id is its SHA-256: the same file sent twice
-- is one row). It holds no figures — only what the owner's status list shows.
CREATE TABLE uploads (
	id TEXT PRIMARY KEY,                  -- 'upload:<sha-256 hex>'; also work.gmail_id and messages.gmail_id
	filename TEXT NOT NULL,
	size INTEGER NOT NULL CHECK (typeof(size) = 'integer' AND size > 0),
	via TEXT NOT NULL CHECK (via IN ('page', 'share')),
	-- The card the owner said it is (optional), or later picked in 待確認. NULL =
	-- the reader decides from the statement's own text.
	account_id TEXT REFERENCES accounts (id),
	-- After the reading: [{account_id, period_end, status: imported|duplicate}],
	-- or {"unknown": ["1234"]} when the card on it matches no account.
	result_json TEXT,
	dismissed_at TEXT,                    -- the owner said 知道了 / 略過 in 待確認
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX uploads_created ON uploads (created_at);

-- The file itself, ONLY until it is read: base64 text in pieces well under
-- D1's 2 MB row limit. Deleted in the same batch that saves the reading's
-- figures (or when the upload fails, or 14 days after it arrived) — a bank
-- statement is never kept in the database.
CREATE TABLE upload_chunks (
	upload_id TEXT NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
	seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer'),
	data TEXT NOT NULL,
	PRIMARY KEY (upload_id, seq)
);
