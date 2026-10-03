import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { authed } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { requireAccounting } from "@/server/accounting/core";
import { linkedOrganisers } from "@/server/accounting/portal";
import { remittancePdf } from "@/server/accounting/remittance";

/** Organiser portal: receipt for one of the user's own organiser payments (live only). */
export const GET = authed<{ id: string }>(null, async ({ auth, params }) => {
  requireAccounting();
  const id = uuid(params.id, "Payment");
  const mine = (await linkedOrganisers(auth.organisationId, auth.user.id)).map((o) => o.id);
  const [p] = await db.select({ o: schema.acctOrganiserPayments.organiserId, live: schema.acctOrganiserPayments.livemode }).from(schema.acctOrganiserPayments)
    .where(and(eq(schema.acctOrganiserPayments.id, id), eq(schema.acctOrganiserPayments.organisationId, auth.organisationId)));
  if (!p || !p.live || !mine.includes(p.o)) throw new AppError("not_found", "Payment not found");
  const r = await remittancePdf(auth.organisationId, id);
  return new Response(new Uint8Array(r.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store" } });
});
