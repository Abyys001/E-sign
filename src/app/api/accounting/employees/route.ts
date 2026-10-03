import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { isLive } from "@/server/accounting/core";
import { createEmployee, EmployeeInput, employeeView, listEmployees } from "@/server/accounting/payroll";

export const GET = acct("accounting.payroll", async ({ auth, mode }) => ({ items: await listEmployees(auth.organisationId, isLive(mode)), mode }));
export const POST = acct("accounting.payroll", async ({ req, auth, ctx }) => employeeView(await createEmployee({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, EmployeeInput))));
