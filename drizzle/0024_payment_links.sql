-- Payment links: a branded public page (/pay/<slug>) for one event and price that opens a Stripe Checkout Session.
-- Additive only.
ALTER TABLE "acct_settings" ADD COLUMN IF NOT EXISTS "payment_link_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_payment_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "livemode" boolean NOT NULL,
  "slug" text NOT NULL,
  "event_id" uuid REFERENCES "acct_events"("id"),
  "event_name" text NOT NULL,
  "event_code" text,
  "title" text NOT NULL,
  "description" text,
  "venue" text,
  "event_date" date,
  "amount" bigint NOT NULL,
  "currency" text NOT NULL,
  "fee_bps" integer DEFAULT 0 NOT NULL,
  "adjustable_quantity" boolean DEFAULT true NOT NULL,
  "max_quantity" integer DEFAULT 10 NOT NULL,
  "branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "expires_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "acct_payment_links_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "acct_payment_links_fee_ck" CHECK ("fee_bps" >= 0 AND "fee_bps" <= 5000),
  CONSTRAINT "acct_payment_links_qty_ck" CHECK ("max_quantity" >= 1 AND "max_quantity" <= 99)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_payment_links_slug_uq" ON "acct_payment_links" ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_payment_links_org_idx" ON "acct_payment_links" ("organisation_id", "livemode", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_payment_link_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "acct_payment_links"("id"),
  "session_id" text NOT NULL,
  "quantity" integer NOT NULL,
  "amount_total" bigint NOT NULL,
  "currency" text NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "customer_email" text,
  "customer_name" text,
  "payment_intent_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_payment_link_sessions_uq" ON "acct_payment_link_sessions" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_payment_link_sessions_link_idx" ON "acct_payment_link_sessions" ("link_id", "created_at" DESC);
