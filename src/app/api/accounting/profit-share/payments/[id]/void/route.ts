import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { voidPartnerPayment } from "@/server/accounting/profit-share";

export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ reason: z.string().trim().min(3).max(1000) }));
  return voidPartnerPayment({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payment"), b.reason);
});
