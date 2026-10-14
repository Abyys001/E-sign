import { rematchUnmatched } from "@/server/accounting/manual";
import { syncCashback } from "@/server/accounting/cashback";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { agreementsFor, EventPatch, updateEvent } from "@/server/accounting/entities";
import { dimensionSummary } from "@/server/accounting/reports";

/** Event with its organiser, agreement history and profitability per currency. */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params, mode }) => {
  const id = uuid(params.id, "Event");
  const [r] = await db.select({ e: schema.acctEvents, organiserName: schema.acctOrganisers.name }).from(schema.acctEvents).leftJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, schema.acctEvents.organiserId)).where(and(eq(schema.acctEvents.id, id), eq(schema.acctEvents.organisationId, auth.organisationId)));
  if (!r) throw new AppError("not_found", "Event not found");
  const [agreements, summary] = await Promise.all([agreementsFor(auth.organisationId, id), dimensionSummary(auth.organisationId, mode, { eventId: id })]);
  return { event: { ...r.e, organiserName: r.organiserName }, agreements, summary, mode };
});

export const PATCH = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const ev = await updateEvent({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Event"), await body(req, EventPatch));
  const rematch = await rematchUnmatched(auth.organisationId, { userId: auth.user.id });
  // finishing / re-opening an event changes the organiser's cashback
  if (ev.organiserId) for (const m of ["live", "test"] as const) await syncCashback(auth.organisationId, m, { userId: auth.user.id, organiserId: ev.organiserId });
  return { ...ev, rematch };
});
