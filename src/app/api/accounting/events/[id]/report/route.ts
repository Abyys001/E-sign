import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { organiserReportPdf } from "@/server/accounting/organiser-report";

/** Event report PDF: the event's sales, refunds, fees, cashback, payments against it and the organiser's whole-account balance. */
export const GET = acct<{ id: string }>("accounting.view", async ({ req, auth, params, mode }) => {
  const id = uuid(params.id, "Event");
  const q = query(req, z.object({ internal: z.enum(["0", "1"]).optional() }).passthrough());
  const [e] = await db.select({ organiserId: schema.acctEvents.organiserId }).from(schema.acctEvents).where(and(eq(schema.acctEvents.id, id), eq(schema.acctEvents.organisationId, auth.organisationId)));
  if (!e) throw new AppError("not_found", "Event not found");
  if (!e.organiserId) throw new AppError("invalid_state", "Link this event to an organiser first.");
  const r = await organiserReportPdf(auth.organisationId, mode, e.organiserId, { eventIds: [id], eventReport: true, internal: q.internal === "1" });
  return new Response(new Uint8Array(r.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store" } });
});
