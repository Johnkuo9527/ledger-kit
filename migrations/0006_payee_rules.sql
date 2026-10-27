-- round 2 (the owner's payee rules). Additive only: one new table. Nothing
-- already in the database changes here; the upkeep's look back (piece
-- "rules") applies the rules to old lines, logged in line_events like every
-- other change. CONTRACT.md §8 has the meaning.
--
-- New line kinds need no column: 'investment', 'loan_repayment' and
-- 'friend_transfer' join lines.kind (kinds are not a CHECK; src/types.ts).

-- The owner's word on a payee: what the money paid to it IS (kind) and/or the
-- category its lines go in. Beats the detection rules and every model, now and
-- for every later line. merchant_key is the key as the ledger writes it
-- (src/merchant.ts); a rule also covers keys that START with its words
-- ("BELLA" covers "BELLA MOBILE ENDING"), and a bank's masked form of the name
-- ("TAXX MEIXXX") when exactly one rule fits it (src/payees.ts).
-- kind: NULL (category only) | 'purchase' (spending) | 'investment' |
--   'loan_repayment' | 'friend_transfer' | 'transfer' (between his own
--   accounts) | 'card_payment'. Only 'purchase' is ever in a spending total.
CREATE TABLE payee_rules (
	merchant_key TEXT PRIMARY KEY,
	kind TEXT,
	category TEXT,
	set_by TEXT NOT NULL DEFAULT 'owner',
	updated_at TEXT NOT NULL,
	CHECK (kind IS NOT NULL OR category IS NOT NULL)
);

