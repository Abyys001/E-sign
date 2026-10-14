-- Send money from the Stripe financial account (Global Payouts / OutboundPayments v2) to organisers, profit-share
-- partners and suppliers. Additive only. Recipients and their bank details live at Stripe; we keep only the ids.
ALTER TABLE "acct_settings" ADD COLUMN IF NOT EXISTS "payout_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "acct_organisers" ADD COLUMN IF NOT EXISTS "stripe_recipient_id" text;
--> statement-breakpoint
ALTER TABLE "acct_profit_partners" ADD COLUMN IF NOT EXISTS "stripe_recipient_id" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_stripe_outbound" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "livemode" boolean NOT NULL,
  "payee_type" text NOT NULL,
  "organiser_id" uuid REFERENCES "acct_organisers"("id"),
  "event_id" uuid REFERENCES "acct_events"("id"),
  "partner_id" uuid REFERENCES "acct_profit_partners"("id"),
  "bill_id" uuid REFERENCES "acct_bills"("id"),
  "payee_name" text NOT NULL,
  "recipient_id" text NOT NULL,
  "payout_method_id" text,
  "payout_method_label" text,
  "financial_account_id" text NOT NULL,
  "amount" bigint NOT NULL,
  "currency" text NOT NULL,
  "to_currency" text,
  "credited_amount" bigint,
  "fee_amount" bigint NOT NULL DEFAULT 0,
  "description" text,
  "statement_descriptor" text,
  "quote_id" text,
  "verification_id" text,
  "verification_result" text,
  "stripe_id" text,
  "status" text NOT NULL,
  "stripe_status" text,
  "failure" text,
  "organiser_payment_id" uuid REFERENCES "acct_organiser_payments"("id"),
  "partner_payment_id" uuid REFERENCES "acct_partner_payments"("id"),
  "raw" jsonb,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "acct_stripe_outbound_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "acct_stripe_outbound_payee_ck" CHECK ("payee_type" in ('ORGANISER','PARTNER','BILL'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_stripe_outbound_org_idx" ON "acct_stripe_outbound" ("organisation_id","livemode","created_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_stripe_outbound_stripe_uq" ON "acct_stripe_outbound" ("stripe_id") WHERE "stripe_id" is not null;
