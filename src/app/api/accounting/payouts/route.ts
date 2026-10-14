import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { listPayouts, sendPayout, SendInput } from "@/server/accounting/stripe-payouts";

/** Money sent from the Stripe financial account. Sending needs accounting.admin and a fresh re-authentication. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Pagination);
  return { ...(await listPayouts(auth.organisationId, mode, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize };
});
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  return sendPayout({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, SendInput));
});
