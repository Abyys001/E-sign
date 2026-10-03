import { acct } from "@/server/accounting/http";
import { detectedCodes } from "@/server/accounting/queries";

/** Event codes seen in Stripe that have no Bilit event yet. */
export const GET = acct("accounting.view", async ({ auth }) => ({ items: await detectedCodes(auth.organisationId) }));
