import { acct } from "@/server/accounting/http";
import { refreshSessions } from "@/server/accounting/payment-links";

/** Re-check open checkouts with Stripe. */
export const POST = acct("accounting.manage", async ({ auth, mode }) => refreshSessions(auth.organisationId, mode));
