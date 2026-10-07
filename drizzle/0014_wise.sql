-- Wise (bank) feed: read-only API connection per organisation + imported transfers / statement lines.
CREATE TABLE IF NOT EXISTS "acct_wise_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"token_enc" text NOT NULL,
	"token_hint" text,
	"profile_id" text,
	"profile_name" text,
	"sca_private_key_enc" text,
	"sca_public_key" text,
	"balances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'CONNECTED' NOT NULL,
	"statements_ok" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_wise_connections_org_uq" ON "acct_wise_connections" USING btree ("organisation_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_wise_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"wise_id" text NOT NULL,
	"source" text NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"status" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"source_amount" bigint,
	"source_currency" text,
	"fee" bigint,
	"counterparty" text,
	"reference" text,
	"description" text,
	"raw" jsonb,
	"organiser_payment_id" uuid REFERENCES "public"."acct_organiser_payments"("id"),
	"suggested_organiser_id" uuid REFERENCES "public"."acct_organisers"("id"),
	"stripe_payout_id" text,
	"ignored" boolean DEFAULT false NOT NULL,
	"ignored_reason" text,
	"ignored_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_wise_transactions_uq" ON "acct_wise_transactions" USING btree ("organisation_id","wise_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_wise_transactions_date_idx" ON "acct_wise_transactions" USING btree ("organisation_id","occurred_at");
