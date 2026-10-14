import { NextResponse } from "next/server";
import { clientIp, open } from "@/server/http";
import { requireAccounting } from "@/server/accounting/core";
import { receiveTreasuryWebhook } from "@/server/treasury/webhook";

/** Stripe Issuing/Treasury → Bilit treasury portal. Signature-verified before anything is read; idempotent. */
export const POST = open(async ({ req }) => {
  requireAccounting();
  const raw = await req.text();
  return NextResponse.json(await receiveTreasuryWebhook(raw, req.headers.get("stripe-signature"), clientIp(req)));
});
