import { NextResponse } from "next/server";
import { clientIp, open } from "@/server/http";
import { requireAccounting } from "@/server/accounting/core";
import { receiveStripeWebhook } from "@/server/accounting/webhook";

/** Stripe → Bilit finance. Signature-verified before anything is read; see server/accounting/webhook.ts. */
export const POST = open(async ({ req }) => {
  requireAccounting();
  const raw = await req.text(); // the exact bytes Stripe signed; never re-serialised
  return NextResponse.json(await receiveStripeWebhook(raw, req.headers.get("stripe-signature"), clientIp(req)));
});
