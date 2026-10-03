import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { payPayslip, PayslipPay } from "@/server/accounting/payroll";

export const POST = acct<{ id: string }>("accounting.payroll", async ({ req, auth, ctx, params }) => payPayslip({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payslip"), await body(req, PayslipPay)));
