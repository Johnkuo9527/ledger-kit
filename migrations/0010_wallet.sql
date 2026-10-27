-- (14 Oct 2026): a stored-value wallet — GrabPay. Additive only: no
-- column dropped, no row deleted, every new column NULL, so everything already
-- in the database reads exactly as before. CONTRACT.md §15 has the meaning.
--
-- A wallet is an account of kind 'wallet' (kinds are checked in code, not SQL).
-- It holds money the owner put in (a top-up: a transfer from his own bank or card,
-- never spending) and pays for things out of it (spending, one line each).

-- The day the ledger starts recording the wallet, and its balance at the start
-- of that day (minor units, in the wallet's currency). Nothing before wallet_since is ever recorded
-- on it: the top-ups before then were already counted as spending.
ALTER TABLE accounts ADD COLUMN wallet_since TEXT;
ALTER TABLE accounts ADD COLUMN wallet_opening_minor INTEGER CHECK (wallet_opening_minor IS NULL OR typeof(wallet_opening_minor) = 'integer');
-- How much of that opening balance was ALREADY counted as spending (in the old
-- top-ups), and the category it was counted in. Spending from the wallet uses
-- it up first-in-first-out; the part of a purchase it covers gets an automatic
-- offset line (kind 'wallet_offset', below) so it is never counted twice.
ALTER TABLE accounts ADD COLUMN wallet_precounted_minor INTEGER CHECK (wallet_precounted_minor IS NULL OR (typeof(wallet_precounted_minor) = 'integer' AND wallet_precounted_minor >= 0));
ALTER TABLE accounts ADD COLUMN wallet_precounted_category TEXT;

-- An offset line (kind 'wallet_offset') names the wallet purchase it offsets.
-- At most one live offset per purchase, even if two runs work it out at once.
ALTER TABLE lines ADD COLUMN offset_of TEXT REFERENCES lines (id);
CREATE UNIQUE INDEX lines_one_offset ON lines (offset_of) WHERE offset_of IS NOT NULL AND state <> 'void';

-- A wallet account is added from seed/accounts.json (kind "wallet").
