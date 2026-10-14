import { acct } from "@/server/accounting/http";
import { detectCapabilities } from "@/server/treasury/admin";
import { safeStripeError } from "@/server/treasury/stripe";
export const GET = acct("treasury.admin", async ({ auth, mode }) => {
  try { return { capabilities: await detectCapabilities(auth.organisationId, mode), error: null }; }
  catch (e) { return { capabilities: null, error: safeStripeError(e) }; }
});
