-- Contracts linked to organisers (and optionally to one event).
CREATE TABLE IF NOT EXISTS "acct_organiser_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id"),
	"organiser_id" uuid NOT NULL REFERENCES "public"."acct_organisers"("id"),
	"contract_id" uuid NOT NULL REFERENCES "public"."contracts"("id"),
	"event_id" uuid REFERENCES "public"."acct_events"("id"),
	"role" text DEFAULT 'OTHER' NOT NULL,
	"note" text,
	"created_by" uuid REFERENCES "public"."users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_organiser_contracts_uq" ON "acct_organiser_contracts" USING btree ("organiser_id","contract_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_organiser_contracts_event_idx" ON "acct_organiser_contracts" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_organiser_contracts_contract_idx" ON "acct_organiser_contracts" USING btree ("contract_id");
