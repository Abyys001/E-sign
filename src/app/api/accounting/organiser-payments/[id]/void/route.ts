import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { voidOrganiserPayment } from "@/server/accounting/manual";

export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ reason: z.string().trim().min(3).max(1000) }));
  return voidOrganiserPayment({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payment"), b.reason);
});
