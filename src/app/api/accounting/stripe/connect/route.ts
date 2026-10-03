import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { ModeSchema } from "@/server/accounting/core";
import { connectStripe, stripeAccountView } from "@/server/accounting/stripe-gateway";

/** Save a Stripe API key (restricted key recommended). Validated against Stripe, then encrypted at rest. */
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ mode: ModeSchema, secretKey: z.string().min(10).max(300) }));
  const row = await connectStripe({ orgId: auth.organisationId, userId: auth.user.id, mode: b.mode, secretKey: b.secretKey, ctx });
  return stripeAccountView(row, b.mode);
});
