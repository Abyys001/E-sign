CREATE TABLE "agreement_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"jurisdiction" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"clause_selection" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreement_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"agreement_type" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clause_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clause_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"jurisdiction" text DEFAULT 'ANY' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"body" text NOT NULL,
	"variable_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"condition" jsonb,
	"author_id" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"key" text NOT NULL,
	"category" text NOT NULL,
	"module" text DEFAULT 'core' NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"agreement_template_version_id" uuid,
	"schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow" text DEFAULT 'B' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'SENT' NOT NULL,
	"auth_mode" text DEFAULT 'NONE' NOT NULL,
	"passcode_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"submission_rev" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"submitted_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"contract_id" uuid,
	"generation_status" text DEFAULT 'NONE' NOT NULL,
	"generation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "agreement_template_version_id" uuid;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "intake_submission_id" uuid;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "generation_key" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "generation_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "legal_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement_template_versions" ADD CONSTRAINT "agreement_template_versions_template_id_agreement_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."agreement_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_template_versions" ADD CONSTRAINT "agreement_template_versions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_template_versions" ADD CONSTRAINT "agreement_template_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_templates" ADD CONSTRAINT "agreement_templates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_templates" ADD CONSTRAINT "agreement_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clause_versions" ADD CONSTRAINT "clause_versions_clause_id_clauses_id_fk" FOREIGN KEY ("clause_id") REFERENCES "public"."clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clause_versions" ADD CONSTRAINT "clause_versions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clause_versions" ADD CONSTRAINT "clause_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clauses" ADD CONSTRAINT "clauses_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_form_versions" ADD CONSTRAINT "intake_form_versions_form_id_intake_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."intake_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_form_versions" ADD CONSTRAINT "intake_form_versions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_form_versions" ADD CONSTRAINT "intake_form_versions_agreement_template_version_id_agreement_template_versions_id_fk" FOREIGN KEY ("agreement_template_version_id") REFERENCES "public"."agreement_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_form_versions" ADD CONSTRAINT "intake_form_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_forms" ADD CONSTRAINT "intake_forms_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_forms" ADD CONSTRAINT "intake_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD CONSTRAINT "intake_invitations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD CONSTRAINT "intake_invitations_form_id_intake_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."intake_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD CONSTRAINT "intake_invitations_form_version_id_intake_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."intake_form_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_invitations" ADD CONSTRAINT "intake_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_form_id_intake_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."intake_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_form_version_id_intake_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."intake_form_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_invitation_id_intake_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."intake_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submissions" ADD CONSTRAINT "intake_submissions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_template_versions_uq" ON "agreement_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE INDEX "agreement_templates_org_idx" ON "agreement_templates" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "clause_versions_uq" ON "clause_versions" USING btree ("clause_id","language","jurisdiction","version");--> statement-breakpoint
CREATE INDEX "clause_versions_org_idx" ON "clause_versions" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "clauses_org_key_uq" ON "clauses" USING btree ("organisation_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_form_versions_uq" ON "intake_form_versions" USING btree ("form_id","version");--> statement-breakpoint
CREATE INDEX "intake_forms_org_idx" ON "intake_forms" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_invitations_token_uq" ON "intake_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "intake_invitations_org_idx" ON "intake_invitations" USING btree ("organisation_id","form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_submissions_invitation_uq" ON "intake_submissions" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "intake_submissions_org_idx" ON "intake_submissions" USING btree ("organisation_id","form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_generation_key_uq" ON "contracts" USING btree ("generation_key");--> statement-breakpoint
CREATE INDEX "contracts_intake_submission_idx" ON "contracts" USING btree ("intake_submission_id");
-- Published legal content is immutable: a change means a new version. Status may move PUBLISHED -> RETIRED and review_status may change.
CREATE OR REPLACE FUNCTION esign_guard_clause_version() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'published clause_version % cannot be deleted', OLD.id USING ERRCODE = 'restrict_violation'; END IF;
    IF NEW.body <> OLD.body OR NEW.variable_schema <> OLD.variable_schema OR NEW.condition IS DISTINCT FROM OLD.condition OR NEW.version <> OLD.version
       OR NEW.language <> OLD.language OR NEW.jurisdiction <> OLD.jurisdiction OR NEW.clause_id <> OLD.clause_id OR (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED') THEN
      RAISE EXCEPTION 'published clause_version % is immutable; create a new version', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER clause_versions_guard BEFORE UPDATE OR DELETE ON clause_versions FOR EACH ROW EXECUTE FUNCTION esign_guard_clause_version();--> statement-breakpoint
CREATE OR REPLACE FUNCTION esign_guard_published_version() RETURNS trigger AS $$
BEGIN
  IF OLD.published THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'published % cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END IF;
    IF NEW.published = false OR to_jsonb(NEW) - 'published_at' <> to_jsonb(OLD) - 'published_at' THEN
      RAISE EXCEPTION 'published % row % is immutable; create a new version', TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER agreement_template_versions_guard BEFORE UPDATE OR DELETE ON agreement_template_versions FOR EACH ROW EXECUTE FUNCTION esign_guard_published_version();--> statement-breakpoint
CREATE TRIGGER intake_form_versions_guard BEFORE UPDATE OR DELETE ON intake_form_versions FOR EACH ROW EXECUTE FUNCTION esign_guard_published_version();
