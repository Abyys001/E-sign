-- Ticket-system CSV exports per event: what each order's ticket price and booking fee really were. Applying one trues up
-- the booked booking fee to what customers were charged (Dr organiser share / Cr organiser payable). Additive only.
CREATE TABLE IF NOT EXISTS "acct_ticket_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "livemode" boolean NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "acct_events"("id"),
  "file_name" text,
  "status" text DEFAULT 'PREVIEW' NOT NULL,
  "summary" jsonb NOT NULL,
  "orders" jsonb NOT NULL,
  "applied_amount" bigint,
  "journal_entry_id" uuid REFERENCES "acct_journal_entries"("id"),
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_by" uuid REFERENCES "users"("id"),
  "applied_at" timestamp with time zone,
  CONSTRAINT "acct_ticket_imports_status_ck" CHECK ("status" IN ('PREVIEW', 'APPLIED', 'SUPERSEDED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_ticket_imports_event_idx" ON "acct_ticket_imports" ("organisation_id", "event_id", "created_at" DESC);
