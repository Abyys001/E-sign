-- Dedicated Stripe key + Treasury financial account for the staff card portal (per test/live mode). Additive.
ALTER TABLE "acct_settings" ADD COLUMN IF NOT EXISTS "treasury_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
