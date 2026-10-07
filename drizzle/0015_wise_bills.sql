-- A Wise movement can be booked as a supplier invoice / expense instead of an organiser payment.
ALTER TABLE "acct_wise_transactions" ADD COLUMN IF NOT EXISTS "bill_id" uuid REFERENCES "public"."acct_bills"("id");
