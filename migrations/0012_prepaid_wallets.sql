-- (19 Oct 2026): any prepaid wallet, not just GrabPay — and the owner's
-- Sample Bistro stored-value card. Additive only: no column dropped, no row
-- deleted, every new column NULL, so everything already in the database reads
-- exactly as before (GrabPay's own top-up rule stays in code, src/wallet.ts).
-- CONTRACT.md §15 has the meaning.

-- A wallet's own top-up rule, as data, so a new prepaid card is one row:
-- a card or bank line whose merchant contains this text (letters and digits
-- only, case ignored: "SAMPLE BISTRO" matches "SAMPLE BISTRO    SINGAPORE")
-- is money the owner put into this wallet — from the wallet's start date only, and
-- (when wallet_topup_whole_dollars = 1) only for a whole number of dollars
-- (S$100, S$200); any other amount stays a normal purchase, since he may also
-- pay there by card directly. The owner's own word on a payee or a line beats it.
ALTER TABLE accounts ADD COLUMN wallet_topup_merchant TEXT;
ALTER TABLE accounts ADD COLUMN wallet_topup_whole_dollars INTEGER CHECK (wallet_topup_whole_dollars IS NULL OR wallet_topup_whole_dollars IN (0, 1));
-- The category a purchase the owner tells from this wallet takes when he names none
-- (Sample Bistro: Food). NULL = none (GrabPay: he names it each time).
ALTER TABLE accounts ADD COLUMN wallet_spend_category TEXT;

-- A prepaid card is added from seed/accounts.json (kind "wallet", "topup").
