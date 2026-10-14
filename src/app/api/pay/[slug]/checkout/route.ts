import { open, body } from "@/server/http";
import { requireAccounting } from "@/server/accounting/core";
import { CheckoutInput, startCheckout } from "@/server/accounting/payment-links";

/** Public: start a Stripe Checkout for a payment link. Rate-limited per IP; returns the Stripe checkout URL. */
export const POST = open<{ slug: string }>(async ({ req, ctx, params }) => {
  requireAccounting();
  return startCheckout(params.slug, await body(req, CheckoutInput), ctx);
});
