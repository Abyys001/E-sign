CREATE TABLE IF NOT EXISTS "acct_telegram_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "telegram_user_id" bigint NOT NULL,
  "chat_id" bigint NOT NULL,
  "username" text,
  "voice_replies" boolean,
  "language" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_telegram_users_tg_uq" ON "acct_telegram_users" ("organisation_id", "telegram_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_telegram_pairings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "code_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_telegram_pairings_code_uq" ON "acct_telegram_pairings" ("code_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_telegram_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "telegram_user_id" bigint NOT NULL,
  "messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "pending" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_telegram_sessions_uq" ON "acct_telegram_sessions" ("organisation_id", "telegram_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_telegram_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
  "update_id" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_telegram_updates_uq" ON "acct_telegram_updates" ("organisation_id", "update_id");
