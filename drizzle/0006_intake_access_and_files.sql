CREATE TABLE "intake_access_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"session_id" uuid,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_access_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"session_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"ip" text,
	"ip_version" integer,
	"user_agent" text,
	"browser" text,
	"browser_version" text,
	"os" text,
	"os_version" text,
	"device_type" text,
	"device_key" text,
	"screen_width" integer,
	"screen_height" integer,
	"pixel_ratio" real,
	"language" text,
	"timezone" text,
	"platform" text,
	"referrer" text,
	"page_visits" integer DEFAULT 1 NOT NULL,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"section_progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"storage_object_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"email_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD COLUMN "token_nonce" text NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD COLUMN "first_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD COLUMN "last_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD COLUMN "last_saved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake_access_sessions" ADD CONSTRAINT "intake_access_sessions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_access_sessions" ADD CONSTRAINT "intake_access_sessions_form_id_intake_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."intake_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_access_sessions" ADD CONSTRAINT "intake_access_sessions_form_version_id_intake_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."intake_form_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_access_sessions" ADD CONSTRAINT "intake_access_sessions_invitation_id_intake_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."intake_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_files" ADD CONSTRAINT "intake_files_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_files" ADD CONSTRAINT "intake_files_submission_id_intake_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."intake_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_files" ADD CONSTRAINT "intake_files_storage_object_id_storage_objects_id_fk" FOREIGN KEY ("storage_object_id") REFERENCES "public"."storage_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_otps" ADD CONSTRAINT "intake_otps_invitation_id_intake_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."intake_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_otps" ADD CONSTRAINT "intake_otps_session_id_intake_access_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."intake_access_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_reminders" ADD CONSTRAINT "intake_reminders_invitation_id_intake_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."intake_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_access_events_inv_idx" ON "intake_access_events" USING btree ("invitation_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "intake_access_events_org_idx" ON "intake_access_events" USING btree ("organisation_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "intake_access_events_session_idx" ON "intake_access_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "intake_access_events_ip_idx" ON "intake_access_events" USING btree ("ip");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_access_sessions_hash_uq" ON "intake_access_sessions" USING btree ("session_hash");--> statement-breakpoint
CREATE INDEX "intake_access_sessions_org_idx" ON "intake_access_sessions" USING btree ("organisation_id","form_id");--> statement-breakpoint
CREATE INDEX "intake_access_sessions_inv_idx" ON "intake_access_sessions" USING btree ("invitation_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "intake_access_sessions_ip_idx" ON "intake_access_sessions" USING btree ("ip");--> statement-breakpoint
CREATE INDEX "intake_access_sessions_seen_idx" ON "intake_access_sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "intake_files_sub_idx" ON "intake_files" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "intake_otps_inv_idx" ON "intake_otps" USING btree ("invitation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "intake_reminders_uq" ON "intake_reminders" USING btree ("invitation_id","slot");
-- Access events are append-only: rows may be deleted only by the retention job (privacy), never edited.
CREATE OR REPLACE FUNCTION esign_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted (append-only)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER intake_access_events_no_update BEFORE UPDATE ON intake_access_events FOR EACH ROW EXECUTE FUNCTION esign_reject_update();
