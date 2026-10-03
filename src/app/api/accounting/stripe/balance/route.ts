import { acct } from "@/server/accounting/http";
import { AppError } from "@/server/errors";
import { gatewayFor, getStripeAccount, safeStripeError } from "@/server/accounting/stripe-gateway";

/** Live Stripe balance (available + pending per currency), straight from the API. */
export const GET = acct("accounting.view", async ({ auth, mode }) => {
  const acc = await getStripeAccount(auth.organisationId, mode);
  if (!acc?.secretKeyEnc) throw new AppError("invalid_state", `Stripe ${mode} mode is not connected.`);
  try {
    const b = await gatewayFor(acc).retrieveBalance();
    return { mode, livemode: b.livemode, available: b.available.map((x) => ({ currency: x.currency, amount: x.amount })), pending: b.pending.map((x) => ({ currency: x.currency, amount: x.amount })) };
  } catch (e) { throw new AppError("invalid_state", `Stripe: ${safeStripeError(e)}`); }
});
