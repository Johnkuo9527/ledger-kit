-- round 2, part C (11 Oct 2026). Additive only: no column dropped, no
-- row deleted, every new column NULL or defaulted, so everything already in
-- the database reads exactly as before. CONTRACT.md §8 has the meaning.

-- 6. A card that was lost and replaced: its successor. The ledger treats the
-- two as one card going forward — the successor's coverage counts the old
-- card's statements, and 繳款 shows one card. Set from seed/accounts.json
-- ("replaced_by").
ALTER TABLE accounts ADD COLUMN replaced_by TEXT REFERENCES accounts (id);

-- Refinement of 0006: a payee rule covers transfer lines (PayNow, FAST, bank
-- transfers) only — never a card purchase, so a shop whose name starts like a
-- friend's is not a friend transfer. card_lines = 1: the owner made this rule from
-- a card line himself, so it ALSO covers card lines with exactly that
-- merchant name (never by prefix or a masked name).
ALTER TABLE payee_rules ADD COLUMN card_lines INTEGER NOT NULL DEFAULT 0 CHECK (card_lines IN (0, 1));

-- A. Flags the owner looked at and said are fine ("the charge is real", "no
-- original to link"): comma-separated flag names. The ledger never raises
-- these flags on that line again; a flag he did not answer still can.
ALTER TABLE lines ADD COLUMN owner_ok TEXT;
