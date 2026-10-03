import { env } from "@/lib/env";
import { acct } from "@/server/accounting/http";
import { getStripeAccount, STRIPE_WEBHOOK_EVENTS, stripeAccountView } from "@/server/accounting/stripe-gateway";
import { webhookHealth } from "@/server/accounting/webhook";

/** Connection status for both modes. Secrets are never included — only masked hints. */
export const GET = acct("accounting.view", async ({ auth }) => {
  const modes = await Promise.all((["test", "live"] as const).map(async (m) => {
    const a = await getStripeAccount(auth.organisationId, m);
    return { ...stripeAccountView(a, m), webhook: a ? await webhookHealth(a.id) : null };
  }));
  return { webhookUrl: `${new URL(env().APP_URL).origin}/api/webhooks/stripe`, events: STRIPE_WEBHOOK_EVENTS, modes };
});
