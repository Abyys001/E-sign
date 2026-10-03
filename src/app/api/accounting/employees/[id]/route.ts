import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { EmployeeInput, employeeView, updateEmployee } from "@/server/accounting/payroll";

/** Employee; `?bank=1` reveals bank details (recent re-authentication required). */
export const GET = acct<{ id: string }>("accounting.payroll", async ({ req, auth, params }) => {
  const q = query(req, z.object({ bank: z.string().optional() }).passthrough());
  const [e] = await db.select().from(schema.acctEmployees).where(and(eq(schema.acctEmployees.id, uuid(params.id, "Employee")), eq(schema.acctEmployees.organisationId, auth.organisationId)));
  if (!e) throw new AppError("not_found", "Employee not found");
  if (q.bank) requireElevation(auth);
  return employeeView(e, !!q.bank);
});
export const PATCH = acct<{ id: string }>("accounting.payroll", async ({ req, auth, ctx, params }) => employeeView(await updateEmployee({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Employee"), await body(req, EmployeeInput.partial()))));
