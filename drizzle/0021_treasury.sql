-- Stripe Treasury staff card portal. All additive; no existing table is changed. Money is bigint minor units.
CREATE TABLE IF NOT EXISTS "treasury_cardholders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "livemode" boolean NOT NULL,
  "stripe_cardholder_id" text NOT NULL,
  "name" text NOT NULL, "email" text, "phone_number" text,
  "type" text NOT NULL DEFAULT 'individual',
  "status" text NOT NULL DEFAULT 'active',
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_cardholders_uq" ON "treasury_cardholders" ("organisation_id","stripe_cardholder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_cardholders_org_idx" ON "treasury_cardholders" ("organisation_id","livemode");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "livemode" boolean NOT NULL,
  "stripe_card_id" text NOT NULL,
  "cardholder_id" uuid NOT NULL REFERENCES "treasury_cardholders"("id"),
  "financial_account_id" text,
  "brand" text, "last4" text, "exp_month" integer, "exp_year" integer,
  "currency" text NOT NULL,
  "type" text NOT NULL DEFAULT 'virtual',
  "status" text NOT NULL DEFAULT 'active',
  "spending_controls" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "nickname" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_cards_uq" ON "treasury_cards" ("organisation_id","stripe_card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_cards_org_idx" ON "treasury_cards" ("organisation_id","livemode");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_staff" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "email" text NOT NULL, "name" text NOT NULL, "password_hash" text,
  "status" text NOT NULL DEFAULT 'INVITED',
  "can_freeze_card" boolean NOT NULL DEFAULT false,
  "failed_logins" integer NOT NULL DEFAULT 0,
  "locked_until" timestamptz, "last_login_at" timestamptz,
  "created_by" uuid REFERENCES "users"("id"),
  "suspended_by" uuid REFERENCES "users"("id"), "suspended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_staff_email_uq" ON "treasury_staff" ("organisation_id", lower("email"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_staff_org_idx" ON "treasury_staff" ("organisation_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_staff_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid NOT NULL REFERENCES "treasury_staff"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL, "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL, "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_staff_tokens_hash_uq" ON "treasury_staff_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_staff_tokens_staff_idx" ON "treasury_staff_tokens" ("staff_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_staff_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid NOT NULL REFERENCES "treasury_staff"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL, "csrf_token" text NOT NULL,
  "ip" text, "user_agent" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_staff_sessions_token_uq" ON "treasury_staff_sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_staff_sessions_staff_idx" ON "treasury_staff_sessions" ("staff_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "staff_id" uuid NOT NULL REFERENCES "treasury_staff"("id"),
  "card_id" uuid NOT NULL REFERENCES "treasury_cards"("id"),
  "assigned_by" uuid REFERENCES "users"("id"),
  "assigned_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_by" uuid REFERENCES "users"("id"), "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_assignments_active_uq" ON "treasury_assignments" ("card_id") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_assignments_staff_idx" ON "treasury_assignments" ("staff_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_expenses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "card_id" uuid NOT NULL REFERENCES "treasury_cards"("id"),
  "staff_id" uuid REFERENCES "treasury_staff"("id"),
  "stripe_object_id" text NOT NULL, "note" text,
  "receipt_object_id" uuid REFERENCES "storage_objects"("id"), "receipt_name" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_expenses_uq" ON "treasury_expenses" ("organisation_id","stripe_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_expenses_card_idx" ON "treasury_expenses" ("card_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_limit_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "staff_id" uuid NOT NULL REFERENCES "treasury_staff"("id"),
  "card_id" uuid NOT NULL REFERENCES "treasury_cards"("id"),
  "interval" text NOT NULL DEFAULT 'monthly',
  "current_amount" bigint, "requested_amount" bigint NOT NULL,
  "currency" text NOT NULL, "reason" text,
  "status" text NOT NULL DEFAULT 'PENDING',
  "decided_by" uuid REFERENCES "users"("id"), "decided_at" timestamptz, "decision_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "treasury_limit_requests_amount_ck" CHECK ("requested_amount" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_limit_requests_org_idx" ON "treasury_limit_requests" ("organisation_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_limit_requests_staff_idx" ON "treasury_limit_requests" ("staff_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_stripe_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "stripe_event_id" text NOT NULL, "type" text NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(), "processed_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_stripe_events_uq" ON "treasury_stripe_events" ("stripe_event_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "actor_type" text NOT NULL, "actor_id" text, "actor_name" text,
  "action" text NOT NULL, "resource" text, "resource_id" text,
  "outcome" text NOT NULL, "ip" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_audit_org_idx" ON "treasury_audit" ("organisation_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_audit_actor_idx" ON "treasury_audit" ("actor_type","actor_id");
