import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { refreshFromStripe } from "@/server/accounting/refunds";

/** Re-fetch the payment and its refunds from Stripe now. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ auth, params }) => refreshFromStripe(auth.organisationId, uuid(params.id, "Transaction")));
