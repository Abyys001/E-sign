-- Profit share partners (e.g. the web developer gets 10% of each event's profit) and payments to them.
CREATE TABLE IF NOT EXISTS "acct_profit_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"name" text NOT NULL,
	"role" text,
	"email" text,
	"share_bps" integer NOT NULL,
	"applies_from" date,
	"losses_count" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acct_profit_partners_bps_ck" CHECK ("share_bps" >= 0 AND "share_bps" <= 10000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_profit_partners_org_idx" ON "acct_profit_partners" USING btree ("organisation_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_partner_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"livemode" boolean NOT NULL,
	"partner_id" uuid NOT NULL REFERENCES "public"."acct_profit_partners"("id"),
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"payment_date" date NOT NULL,
	"method" text DEFAULT 'BANK_TRANSFER' NOT NULL,
	"bank_reference" text,
	"notes" text,
	"status" text DEFAULT 'PAID' NOT NULL,
	"journal_entry_id" uuid REFERENCES "public"."acct_journal_entries"("id"),
	"void_entry_id" uuid REFERENCES "public"."acct_journal_entries"("id"),
	"void_reason" text,
	"voided_by" uuid REFERENCES "public"."users"("id"),
	"voided_at" timestamp with time zone,
	"created_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acct_partner_payments_amount_ck" CHECK ("amount" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_partner_payments_partner_idx" ON "acct_partner_payments" USING btree ("partner_id", "payment_date");--> statement-breakpoint
ALTER TABLE "acct_wise_transactions" ADD COLUMN IF NOT EXISTS "partner_payment_id" uuid REFERENCES "public"."acct_partner_payments"("id");
