import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { voidPayslip } from "@/server/accounting/payroll";

export const POST = acct<{ id: string }>("accounting.payroll", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ reason: z.string().trim().min(3).max(1000) }));
  return voidPayslip({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payslip"), b.reason);
});
