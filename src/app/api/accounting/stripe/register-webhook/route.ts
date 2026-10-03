import { z } from "zod";
import { env } from "@/lib/env";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { AppError } from "@/server/errors";
import { ModeSchema } from "@/server/accounting/core";
import { gatewayFor, getStripeAccount, safeStripeError, setWebhookSecret, STRIPE_WEBHOOK_EVENTS } from "@/server/accounting/stripe-gateway";

/** Create the production webhook endpoint in Stripe (needs a key with Webhook Endpoints write access) and keep its secret. */
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ mode: ModeSchema }));
  const url = `${new URL(env().APP_URL).origin}/api/webhooks/stripe`;
  if (!url.startsWith("https://")) throw new AppError("invalid_state", "Stripe only delivers to public https:// endpoints. For local development use `stripe listen` and paste its secret instead.");
  const acc = await getStripeAccount(auth.organisationId, b.mode);
  if (!acc) throw new AppError("invalid_state", "Connect the Stripe API key first.");
  let w: { id: string; secret: string };
  try { w = await gatewayFor(acc).createWebhookEndpoint(url, [...STRIPE_WEBHOOK_EVENTS]); }
  catch (e) { throw new AppError("invalid_state", `Stripe refused to create the endpoint: ${safeStripeError(e)}. Create it in the Stripe Dashboard and paste the signing secret instead.`); }
  await setWebhookSecret({ orgId: auth.organisationId, userId: auth.user.id, mode: b.mode, secret: w.secret, endpointId: w.id, ctx });
  return { ok: true, endpointId: w.id, url };
});
