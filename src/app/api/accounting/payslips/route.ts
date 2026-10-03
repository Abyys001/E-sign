import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { IsoDate } from "@/server/accounting/core";
import { createPayslip, listPayslips, PayslipInput } from "@/server/accounting/payroll";

export const GET = acct("accounting.payroll", async ({ req, auth, mode }) => {
  const q = query(req, z.object({ employeeId: z.string().uuid().optional(), status: z.string().max(20).optional(), from: IsoDate.optional(), to: IsoDate.optional() }).passthrough());
  return { items: await listPayslips(auth.organisationId, mode, q), mode };
});
/** Create a draft payslip (pay and deductions entered by hand). */
export const POST = acct("accounting.payroll", async ({ req, auth, ctx }) => createPayslip({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, PayslipInput)));
