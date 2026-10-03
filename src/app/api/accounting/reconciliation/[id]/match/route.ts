import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { matchTransaction, MatchInput } from "@/server/accounting/manual";

/** Assign a Stripe transaction to an event (and so to the event's organiser). Re-posts the ledger; audited. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) =>
  matchTransaction({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Transaction"), await body(req, MatchInput)));
