import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { PayoutInput, preparePayout } from "@/server/accounting/stripe-payouts";

/** Checks + Stripe quote + payee-name check for a payment about to be sent. Moves no money. */
export const POST = acct("accounting.admin", async ({ req, auth }) => preparePayout(auth.organisationId, await body(req, PayoutInput)));
