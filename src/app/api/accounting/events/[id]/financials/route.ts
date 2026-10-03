import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { IsoDate } from "@/server/accounting/core";
import { eventFinancials } from "@/server/accounting/finance";

const Q = z.object({ from: IsoDate.optional(), to: IsoDate.optional() }).passthrough();

/** Event financial dashboard: figures per currency + current booking fee terms. */
export const GET = acct<{ id: string }>("accounting.view", async ({ req, auth, params, mode }) => {
  const id = uuid(params.id, "Event");
  const q = query(req, Q);
  const [r] = await db.select({ e: schema.acctEvents, organiserName: schema.acctOrganisers.name, ag: schema.acctAgreements }).from(schema.acctEvents)
    .leftJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, schema.acctEvents.organiserId)).leftJoin(schema.acctAgreements, eq(schema.acctAgreements.id, schema.acctEvents.currentAgreementId))
    .where(and(eq(schema.acctEvents.id, id), eq(schema.acctEvents.organisationId, auth.organisationId)));
  if (!r) throw new AppError("not_found", "Event not found");
  const figures = await eventFinancials(auth.organisationId, mode, { ...q, eventIds: [id] });
  return { event: { ...r.e, organiserName: r.organiserName }, agreement: r.ag, figures, mode };
});
