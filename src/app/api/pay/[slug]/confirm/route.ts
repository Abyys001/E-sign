import { NextResponse } from "next/server";
import { open } from "@/server/http";
import { AppError } from "@/server/errors";
import { requireAccounting } from "@/server/accounting/core";
import { confirmCheckout } from "@/server/accounting/payment-links";

/** Public: the thank-you page asks Stripe whether this checkout was paid. Rate-limited per IP. */
export const GET = open<{ slug: string }>(async ({ req, ctx, params }) => {
  requireAccounting();
  const r = await confirmCheckout(params.slug, req.nextUrl.searchParams.get("session_id") ?? "", ctx);
  if (!r) throw new AppError("not_found", "Payment not found.");
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
});
