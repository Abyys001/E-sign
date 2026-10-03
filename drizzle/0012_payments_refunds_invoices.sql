-- Stripe payment detail (outcome, card, receipt), refunds issued from the app, customer invoices & credit notes.
ALTER TABLE "stripe_charges" ADD COLUMN "outcome" jsonb;--> statement-breakpoint
ALTER TABLE "stripe_charges" ADD COLUMN "payment_method" jsonb;--> statement-breakpoint
ALTER TABLE "stripe_charges" ADD COLUMN "receipt_url" text;--> statement-breakpoint
ALTER TABLE "stripe_charges" ADD COLUMN "billing_address" jsonb;--> statement-breakpoint
ALTER TABLE "stripe_refunds" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "stripe_refunds" ADD COLUMN "requested_by" uuid REFERENCES "public"."users"("id");--> statement-breakpoint
ALTER TABLE "stripe_refunds" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "stripe_refunds" ADD COLUMN "keep_booking_fee" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "acct_settings" ADD COLUMN "invoice_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "acct_settings" ADD COLUMN "booking_fee_refundable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "acct_settings" ADD COLUMN "ai_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_charges_status_idx" ON "stripe_charges" USING btree ("organisation_id","livemode","status");--> statement-breakpoint
CREATE TABLE "acct_customer_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"livemode" boolean NOT NULL,
	"kind" text NOT NULL,
	"number" text NOT NULL,
	"vat_invoice" boolean DEFAULT false NOT NULL,
	"balance_transaction_ref" uuid NOT NULL REFERENCES "public"."stripe_balance_transactions"("id"),
	"charge_id" text,
	"event_id" uuid REFERENCES "public"."acct_events"("id"),
	"related_invoice_id" uuid,
	"issue_date" date NOT NULL,
	"supply_date" date,
	"currency" text NOT NULL,
	"seller" jsonb NOT NULL,
	"customer" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"net_total" bigint NOT NULL,
	"vat_total" bigint NOT NULL,
	"gross_total" bigint NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"pdf_object_id" uuid REFERENCES "public"."storage_objects"("id"),
	"pdf_sha256" text,
	"void_reason" text,
	"voided_by" uuid REFERENCES "public"."users"("id"),
	"voided_at" timestamp with time zone,
	"created_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acct_customer_invoices_totals_ck" CHECK ("acct_customer_invoices"."gross_total" = "acct_customer_invoices"."net_total" + "acct_customer_invoices"."vat_total")
);--> statement-breakpoint
CREATE UNIQUE INDEX "acct_customer_invoices_number_uq" ON "acct_customer_invoices" USING btree ("organisation_id","number");--> statement-breakpoint
CREATE INDEX "acct_customer_invoices_bt_idx" ON "acct_customer_invoices" USING btree ("balance_transaction_ref");--> statement-breakpoint
CREATE INDEX "acct_customer_invoices_org_idx" ON "acct_customer_invoices" USING btree ("organisation_id","livemode","issue_date" DESC);--> statement-breakpoint
CREATE TRIGGER acct_customer_invoices_no_delete BEFORE DELETE ON acct_customer_invoices FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();
;--> statement-breakpoint
CREATE TABLE "acct_ai_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"livemode" boolean NOT NULL,
	"range_from" date NOT NULL,
	"range_to" date NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"created_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "acct_ai_reviews_org_idx" ON "acct_ai_reviews" USING btree ("organisation_id","created_at" DESC)