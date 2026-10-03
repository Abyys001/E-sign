import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { IsoDate } from "@/server/accounting/core";
import { markPaymentPaid } from "@/server/accounting/manual";

/** Mark a pending organiser payment as paid (posts it to the ledger). */
export const PATCH = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ status: z.literal("PAID"), paymentDate: IsoDate.optional() }));
  return markPaymentPaid({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payment"), b.paymentDate);
});
