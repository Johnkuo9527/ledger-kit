-- The owner says what an incoming payment offsets (Oct 2026):
--   'salary' — income, his pay (kind stays 'income', category 'Salary');
--   'card'   — it reduces a card's spending (kind 'refund', offset_account_id = the card);
--   'line'   — it pays back one purchase (kind 'refund', refund_of = that purchase,
--              its category, offset_account_id = that purchase's account).
-- NULL = not set: ordinary income. Totals by account use the offset account.
ALTER TABLE lines ADD COLUMN income_offset TEXT CHECK (income_offset IS NULL OR income_offset IN ('salary', 'card', 'line'));
ALTER TABLE lines ADD COLUMN offset_account_id TEXT REFERENCES accounts (id);
