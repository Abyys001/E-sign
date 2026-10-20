CREATE TABLE IF NOT EXISTS "acct_phone_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "pin_hash" text NOT NULL,
  "failed_attempts" integer DEFAULT 0 NOT NULL,
  "session_hash" text,
  "session_expires_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone,
  "last_unlock_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_phone_devices_token_uq" ON "acct_phone_devices" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acct_phone_devices_user_idx" ON "acct_phone_devices" ("organisation_id", "user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_phone_pairings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "code_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "device_id" uuid REFERENCES "acct_phone_devices"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_phone_pairings_code_uq" ON "acct_phone_pairings" ("code_hash");
