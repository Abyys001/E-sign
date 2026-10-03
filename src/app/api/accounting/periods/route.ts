import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { PeriodInput, setPeriodStatus } from "@/server/accounting/manual";

export const GET = acct("accounting.view", async ({ auth }) => ({
  items: await db.select({ p: schema.acctPeriods, closedByName: schema.users.name }).from(schema.acctPeriods).leftJoin(schema.users, eq(schema.users.id, schema.acctPeriods.closedBy))
    .where(eq(schema.acctPeriods.organisationId, auth.organisationId)).orderBy(desc(schema.acctPeriods.period)).then((r) => r.map((x) => ({ ...x.p, closedByName: x.closedByName }))),
}));

/** Close or reopen a month. Closed periods reject new postings (database-enforced); every change is audited. */
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  return setPeriodStatus({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, PeriodInput));
});
