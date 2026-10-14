-- Custom payment links (not tied to an event), optionally with an amount the payer enters. Additive only.
ALTER TABLE "acct_payment_links" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'EVENT' NOT NULL;
--> statement-breakpoint
ALTER TABLE "acct_payment_links" ADD COLUMN IF NOT EXISTS "open_amount" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "acct_payment_links" ADD COLUMN IF NOT EXISTS "min_amount" bigint;
--> statement-breakpoint
ALTER TABLE "acct_payment_links" ADD COLUMN IF NOT EXISTS "max_amount" bigint;
--> statement-breakpoint
ALTER TABLE "acct_payment_links" ADD CONSTRAINT "acct_payment_links_kind_ck" CHECK ("kind" IN ('EVENT', 'CUSTOM'));
--> statement-breakpoint
ALTER TABLE "acct_payment_links" ADD CONSTRAINT "acct_payment_links_open_ck" CHECK (NOT "open_amount" OR ("min_amount" > 0 AND "max_amount" >= "min_amount"));
