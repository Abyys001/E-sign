import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { PayslipEdit, updatePayslip } from "@/server/accounting/payroll";

export const PATCH = acct<{ id: string }>("accounting.payroll", async ({ req, auth, ctx, params }) => updatePayslip({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payslip"), await body(req, PayslipEdit)));
