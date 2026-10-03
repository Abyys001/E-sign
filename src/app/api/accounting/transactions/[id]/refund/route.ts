import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { issueRefund, RefundInput } from "@/server/accounting/refunds";

/** Refund (part of) a ticket sale through Stripe. Real money: re-authentication required, amount checked live. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  await rateLimit("accountingExport", auth.user.id);
  return issueRefund({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Transaction"), await body(req, RefundInput));
});
