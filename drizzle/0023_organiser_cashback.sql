-- Organiser cashback: a % of each finished event's ticket sales (after refunds, excluding booking fees) that Bilit gives
-- back to the organiser, added to what the organiser is owed. Additive only.
ALTER TABLE "acct_organisers" ADD COLUMN IF NOT EXISTS "cashback_bps" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "acct_organisers" ADD COLUMN IF NOT EXISTS "cashback_from" date;
--> statement-breakpoint
ALTER TABLE "acct_organisers" ADD CONSTRAINT "acct_organisers_cashback_ck" CHECK ("cashback_bps" >= 0 AND "cashback_bps" <= 10000);
