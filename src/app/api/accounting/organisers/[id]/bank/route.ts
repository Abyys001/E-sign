import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { requireElevation, tx, uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { acctAudit } from "@/server/accounting/core";
import { organiserView } from "@/server/accounting/entities";

/** Decrypted bank details: re-authentication required and every view is audited. */
export const GET = acct<{ id: string }>("accounting.manage", async ({ auth, params, ctx }) => {
  requireElevation(auth);
  const id = uuid(params.id, "Organiser");
  const [o] = await db.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, id), eq(schema.acctOrganisers.organisationId, auth.organisationId)));
  if (!o) throw new AppError("not_found", "Organiser not found");
  await tx((t) => acctAudit(t, { orgId: auth.organisationId, userId: auth.user.id, ctx, action: "organiser.bank_details_viewed", entity: "organiser", entityId: id }));
  return { bankDetails: organiserView(o, true).bankDetails ?? null };
});
