-- Ledger migration 0002 — for the page and the claude.ai connector:
-- the connector's sign-in codes, and a mark on trips the owner has edited.
--
-- The connector signs the owner in the way his other connectors do: his email, then
-- a 6-digit code sent to it, then OAuth (S256 PKCE only). Only the address in
-- the LEDGER_OWNER_EMAIL secret is ever sent a code. The code itself is never
-- stored — only a hash of email + code — and it lasts 10 minutes and 5 tries.
--
-- Its own file because 0001 may already be applied: D1 records migrations by
-- FILENAME, so 0001 is never edited and this is never renamed.

CREATE TABLE login_codes (
	email TEXT PRIMARY KEY,
	code_hash TEXT NOT NULL,              -- SHA-256 hex of "<email>:<code>"
	expires_at INTEGER NOT NULL,          -- ms since the epoch
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer'),
	sent_at INTEGER NOT NULL              -- ms since the epoch; no second code within a minute
);

-- A trip the owner has edited (dates, name, include/exclude) is his, even while it
-- is still only proposed: the daily run's trip proposals (the daily engine,
-- src/trips.ts planProposals) must not move it. Stamped by engine.ts editTrip.
ALTER TABLE trips ADD COLUMN owner_edited_at TEXT;
