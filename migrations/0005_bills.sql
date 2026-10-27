-- round 2 (the owner's first-use fixes). Additive only: no column is
-- dropped, no row deleted, every new column NULL or defaulted, so lines,
-- evidence and statements already in the database stay exactly as they are.
-- CONTRACT.md §8 has the meaning of each.

-- C. Each credit card's statement (cut-off) day and payment due day.
-- settings_source: 'owner' (he set it — never overwritten) | 'statement' (read
-- off his statements) | NULL (not known yet).
ALTER TABLE accounts ADD COLUMN statement_day INTEGER CHECK (statement_day IS NULL OR (typeof(statement_day) = 'integer' AND statement_day BETWEEN 1 AND 31));
ALTER TABLE accounts ADD COLUMN due_day INTEGER CHECK (due_day IS NULL OR (typeof(due_day) = 'integer' AND due_day BETWEEN 1 AND 31));
ALTER TABLE accounts ADD COLUMN settings_source TEXT;

-- D. The bill a statement prints, as printed (card's currency, minor units;
-- a balance he owes is +, a credit balance −). NULL = not printed / read
-- before round 2. previous/statement balance repeat opening/closing for a
-- one-card statement; for a combined bill (6.) they are the WHOLE bill's and
-- sit on the primary piece only.
ALTER TABLE statements ADD COLUMN previous_balance_minor INTEGER CHECK (previous_balance_minor IS NULL OR typeof(previous_balance_minor) = 'integer');
ALTER TABLE statements ADD COLUMN statement_balance_minor INTEGER CHECK (statement_balance_minor IS NULL OR typeof(statement_balance_minor) = 'integer');
ALTER TABLE statements ADD COLUMN minimum_due_minor INTEGER CHECK (minimum_due_minor IS NULL OR typeof(minimum_due_minor) = 'integer');
ALTER TABLE statements ADD COLUMN payments_credited_minor INTEGER CHECK (payments_credited_minor IS NULL OR typeof(payments_credited_minor) = 'integer');
ALTER TABLE statements ADD COLUMN due_date TEXT;
-- 6. One printed bill covering several cards (台新) is split into one
-- statement per card; the pieces share bill_group. bill_primary = 1 on the
-- piece that carries the bill's figures (and on every one-card statement).
ALTER TABLE statements ADD COLUMN bill_group TEXT;
ALTER TABLE statements ADD COLUMN bill_primary INTEGER NOT NULL DEFAULT 1 CHECK (bill_primary IN (0, 1));
-- The to-the-cent bill check (previous − payments + purchases − refunds +
-- fees/interest = statement balance): 'ok' | 'mismatch' | NULL (not checked
-- / figures missing), with its working.
ALTER TABLE statements ADD COLUMN bill_check TEXT;
ALTER TABLE statements ADD COLUMN bill_detail_json TEXT;
-- A. The owner looked at a month that did not add up / a bill that did not
-- match, and said so. It leaves 待確認; the figures stay as they are.
ALTER TABLE statements ADD COLUMN reviewed_at TEXT;
CREATE INDEX statements_bill_group ON statements (bill_group) WHERE bill_group IS NOT NULL;

-- 5. The own account a card_payment / transfer line moves money to or from,
-- when the rules know it (a DBS line paying the HSBC card names that card).
ALTER TABLE lines ADD COLUMN counter_account_id TEXT REFERENCES accounts (id);

-- A. A held alert or statement line the owner dismissed ("not a real charge").
-- Evidence is never deleted; a dismissed row just leaves 待確認.
ALTER TABLE evidence ADD COLUMN dismissed_at TEXT;
ALTER TABLE evidence ADD COLUMN dismiss_reason TEXT;

-- B. owner_status gains 'active' ("still running" — his word beats detection).
-- marked_by = 'owner' when he marked a line in 明細 as a subscription himself:
-- detection then keeps its dates and amount current from that merchant's
-- charges, but never decides whether it is one.
ALTER TABLE subscriptions ADD COLUMN marked_by TEXT;
