import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { finalisePayslip } from "@/server/accounting/payroll";

/** Issue the payslip: number, ledger entry and the stored PDF. */
export const POST = acct<{ id: string }>("accounting.payroll", async ({ auth, ctx, params }) => finalisePayslip({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payslip")));
