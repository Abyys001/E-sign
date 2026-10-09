-- Optional usernames so team members can sign in without typing their email. Case-insensitive and unique when set.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_uq" ON "users" USING btree (lower("username")) WHERE "username" IS NOT NULL;
