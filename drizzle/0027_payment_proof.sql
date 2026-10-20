ALTER TABLE "acct_organiser_payments" ADD COLUMN IF NOT EXISTS "proof_object_id" uuid REFERENCES "storage_objects"("id");
--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD COLUMN IF NOT EXISTS "proof_name" text;
