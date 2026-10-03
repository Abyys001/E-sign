-- Event financials: per-event expenses (with receipts), organiser portal links, payment revisions, reporting FX rates.
ALTER TABLE "acct_settings" ADD COLUMN "reporting_currency" text;--> statement-breakpoint
ALTER TABLE "acct_settings" ADD COLUMN "fx_rates" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD CONSTRAINT "acct_organiser_payments_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "acct_event_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"livemode" boolean NOT NULL,
	"event_id" uuid NOT NULL REFERENCES "public"."acct_events"("id"),
	"organiser_id" uuid REFERENCES "public"."acct_organisers"("id"),
	"name" text NOT NULL,
	"category" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"expense_date" date NOT NULL,
	"description" text,
	"borne_by" text DEFAULT 'BILIT' NOT NULL,
	"receipt_object_id" uuid REFERENCES "public"."storage_objects"("id"),
	"receipt_name" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid REFERENCES "public"."acct_journal_entries"("id"),
	"void_reason" text,
	"voided_by" uuid REFERENCES "public"."users"("id"),
	"voided_at" timestamp with time zone,
	"created_by" uuid REFERENCES "public"."users"("id"),
	"updated_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acct_event_expenses_amount_ck" CHECK ("acct_event_expenses"."amount" > 0)
);--> statement-breakpoint
CREATE INDEX "acct_event_expenses_event_idx" ON "acct_event_expenses" USING btree ("event_id","expense_date" DESC);--> statement-breakpoint
CREATE INDEX "acct_event_expenses_org_idx" ON "acct_event_expenses" USING btree ("organisation_id","livemode","expense_date" DESC);--> statement-breakpoint
CREATE TRIGGER acct_event_expenses_no_delete BEFORE DELETE ON acct_event_expenses FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
CREATE TABLE "acct_organiser_users" (
	"organiser_id" uuid NOT NULL REFERENCES "public"."acct_organisers"("id"),
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id"),
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"created_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "acct_organiser_users_uq" ON "acct_organiser_users" USING btree ("organiser_id","user_id");--> statement-breakpoint
CREATE INDEX "acct_organiser_users_user_idx" ON "acct_organiser_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_journal_entries_source_idx" ON "acct_journal_entries" USING btree ("source_type","source_id");
