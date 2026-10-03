import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { IsoDate } from "@/server/accounting/core";
import { accountantData, accountantPdf, accountantZip, bookkeepingChecks } from "@/server/accounting/accountant";
import { latestAiSummary } from "@/server/accounting/ai";

const Q = z.object({ from: IsoDate, to: IsoDate, format: z.enum(["zip", "pdf", "checks"]).default("checks") }).passthrough().refine((q) => q.from <= q.to, { message: "from must be before to", path: ["to"] });

/** Accountant pack for a period: `zip` (PDF report + CSVs), `pdf` (report only) or `checks` (JSON review checks). */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  const range = { from: q.from, to: q.to };
  if (q.format === "checks") return { checks: await bookkeepingChecks(auth.organisationId, mode, range), range, mode };
  requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
  const data = await accountantData(auth.organisationId, mode, range);
  const ai = await latestAiSummary(auth.organisationId, mode, range);
  const name = `accountant-${mode}-${q.from}-to-${q.to}`;
  if (q.format === "pdf") return new Response(new Uint8Array(await accountantPdf(data, ai)), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}.pdf"`, "cache-control": "private, no-store" } });
  return new Response(new Uint8Array(await accountantZip(data, ai)), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}.zip"`, "cache-control": "private, no-store" } });
});
