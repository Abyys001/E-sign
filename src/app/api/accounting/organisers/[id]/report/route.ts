import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { uuid } from "@/server/api";
import { IsoDate } from "@/server/accounting/core";
import { organiserReportData, organiserReportPdf } from "@/server/accounting/organiser-report";

const Q = z.object({ from: IsoDate.optional(), to: IsoDate.optional(), format: z.enum(["json", "pdf"]).default("json"), internal: z.enum(["0", "1"]).optional() }).passthrough();

/** Organiser account report: payments, refunds, settlement and contracts. `format=pdf` downloads the PDF (organiser copy, or `internal=1`). */
export const GET = acct<{ id: string }>("accounting.view", async ({ req, auth, params, mode }) => {
  const id = uuid(params.id, "Organiser");
  const q = query(req, Q);
  if (q.format === "json") { const d = await organiserReportData(auth.organisationId, mode, id, q); return { payments: d.payments, refunds: d.refunds, contracts: d.contracts, mode }; }
  const r = await organiserReportPdf(auth.organisationId, mode, id, { ...q, internal: q.internal === "1" });
  return new Response(new Uint8Array(r.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store" } });
});
