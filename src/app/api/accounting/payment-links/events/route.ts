import { acct } from "@/server/accounting/http";
import { linkEvents } from "@/server/accounting/payment-links";

/** Events a payment link can sell for, with their booking fee %. */
export const GET = acct("accounting.view", async ({ auth }) => linkEvents(auth.organisationId));
