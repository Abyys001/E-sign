-- XE Currency Data API connection (account id + encrypted API key) and the last rates it returned.
ALTER TABLE "acct_settings" ADD COLUMN IF NOT EXISTS "xe_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
