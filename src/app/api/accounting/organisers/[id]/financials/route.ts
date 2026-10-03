import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { IsoDate } from "@/server/accounting/core";
import { organiserFinancials } from "@/server/accounting/finance";

/** Organiser financial account: totals per currency and per-event settlement. */
export const GET = acct<{ id: string }>("accounting.view", async ({ req, auth, params, mode }) => {
  const id = uuid(params.id, "Organiser");
  const q = query(req, z.object({ from: IsoDate.optional(), to: IsoDate.optional() }).passthrough());
  const [o] = await db.select({ id: schema.acctOrganisers.id }).from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, id), eq(schema.acctOrganisers.organisationId, auth.organisationId)));
  if (!o) throw new AppError("not_found", "Organiser not found");
  return { ...(await organiserFinancials(auth.organisationId, mode, id, q)), mode };
});
