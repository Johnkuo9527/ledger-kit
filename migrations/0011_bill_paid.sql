-- (14 Oct 2026): 繳款 never says 逾期 without evidence. Additive only: no
-- column dropped, no row deleted, every new column NULL, so everything already
-- in the database reads exactly as before. CONTRACT.md §16 has the meaning.

-- The owner's word on how a credit card is paid: 1 = auto-debit from a bank account
-- the ledger does not track (台新), 0 = he pays it himself. NULL = the ledger
-- decides from the card's statements (an auto-debit payment line).
ALTER TABLE accounts ADD COLUMN autopay INTEGER CHECK (autopay IS NULL OR autopay IN (0, 1));

-- On a bill (the statement row carrying its figures): when the owner said "我已繳款"
-- (the ledger could not see the payment). NULL = he has not said so. The next
-- statement still checks it.
ALTER TABLE statements ADD COLUMN paid_by_owner_at TEXT;

-- On a bill the NEXT statement shows was not paid in full: when the owner saw the
-- 待確認 item saying so (「知道了」). NULL = not yet seen.
ALTER TABLE statements ADD COLUMN unpaid_seen_at TEXT;
