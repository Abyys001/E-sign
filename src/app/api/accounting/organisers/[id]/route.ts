import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { OrganiserInput, organiserView, updateOrganiser } from "@/server/accounting/entities";
import { syncCashback } from "@/server/accounting/cashback";
import { listEvents } from "@/server/accounting/queries";
import { dimensionSummary } from "@/server/accounting/reports";

/** Organiser with its events and balance per currency (sales, refunds, fees, payable, paid, outstanding). */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params, mode }) => {
  const id = uuid(params.id, "Organiser");
  const [o] = await db.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, id), eq(schema.acctOrganisers.organisationId, auth.organisationId)));
  if (!o) throw new AppError("not_found", "Organiser not found");
  const [events, balances] = await Promise.all([listEvents(auth.organisationId, { organiserId: id }, { limit: 500, offset: 0 }), dimensionSummary(auth.organisationId, mode, { organiserId: id })]);
  return { organiser: organiserView(o), events: events.items, balances, mode };
});

export const PATCH = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const b = await body(req, OrganiserInput.partial().extend({ reason: z.string().trim().max(500).optional() }));
  const { reason, ...patch } = b;
  const o = await updateOrganiser({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Organiser"), patch, reason);
  if (patch.cashbackPercent !== undefined || patch.cashbackFrom !== undefined) for (const m of ["live", "test"] as const) await syncCashback(auth.organisationId, m, { userId: auth.user.id, organiserId: o.id });
  return organiserView(o);
});
