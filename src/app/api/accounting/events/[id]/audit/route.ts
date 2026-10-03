import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { eventAuditTrail } from "@/server/accounting/finance";

/** Financial audit trail of one event (booking fee changes, payments, expenses, re-assignments). */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => {
  const id = uuid(params.id, "Event");
  const [e] = await db.select({ id: schema.acctEvents.id }).from(schema.acctEvents).where(and(eq(schema.acctEvents.id, id), eq(schema.acctEvents.organisationId, auth.organisationId)));
  if (!e) throw new AppError("not_found", "Event not found");
  return { items: await eventAuditTrail(auth.organisationId, id) };
});
