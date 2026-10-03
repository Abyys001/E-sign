import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { IsoDate } from "@/server/accounting/core";
import { refundsPdf } from "@/server/accounting/refunds-pdf";

/** Refunds statement PDF — for one organiser (`organiserId`, to send to them) or for all. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, z.object({ organiserId: z.string().uuid().optional(), from: IsoDate.optional(), to: IsoDate.optional() }).passthrough());
  const r = await refundsPdf(auth.organisationId, mode, q);
  return new Response(new Uint8Array(r.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store" } });
});
