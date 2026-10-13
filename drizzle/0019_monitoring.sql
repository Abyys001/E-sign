-- Thresholds for the coded financial checks (refund rate, Stripe fee %, event margin, duplicate invoices, webhooks)
-- and the cash-flow forecast assumptions. Additive only; '{}' means "use the defaults" (server/accounting/monitor.ts).
ALTER TABLE "acct_settings" ADD COLUMN IF NOT EXISTS "monitor_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
