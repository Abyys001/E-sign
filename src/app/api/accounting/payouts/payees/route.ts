import { acct } from "@/server/accounting/http";
import { payees } from "@/server/accounting/stripe-payouts";

export const GET = acct("accounting.view", async ({ auth, mode }) => payees(auth.organisationId, mode));
