ALTER TABLE "email_messages" ADD COLUMN "sending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "bounced_at" timestamp with time zone;--> statement-breakpoint
-- A provider that redelivers the same event must not create a second row, notification or audit entry.
DELETE FROM "email_events" a USING "email_events" b WHERE a."email_message_id" = b."email_message_id" AND a."type" = b."type" AND a."occurred_at" = b."occurred_at" AND a."id" > b."id";--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_uq" ON "email_events" USING btree ("email_message_id","type","occurred_at");--> statement-breakpoint
CREATE TABLE "email_suppressions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "email" text NOT NULL,
  "reason" text NOT NULL,
  "source_message_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_uq" ON "email_suppressions" USING btree ("organisation_id","email");
