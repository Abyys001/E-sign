import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { ModeSchema } from "@/server/accounting/core";
import { setWebhookSecret } from "@/server/accounting/stripe-gateway";

/** Store the endpoint signing secret (whsec_…) from the Stripe Dashboard or from `stripe listen`. */
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ mode: ModeSchema, secret: z.string().min(10).max(300) }));
  await setWebhookSecret({ orgId: auth.organisationId, userId: auth.user.id, mode: b.mode, secret: b.secret, ctx });
  return { ok: true };
});
