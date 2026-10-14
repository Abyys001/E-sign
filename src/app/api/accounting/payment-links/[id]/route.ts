import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { LinkPatch, updateLink } from "@/server/accounting/payment-links";

/** Edit, disable or re-enable a payment link. Price, fee and currency lock once it has payments. */
export const PATCH = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) =>
  updateLink({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payment link"), await body(req, LinkPatch)));
