import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { payslipPdf } from "@/server/accounting/payroll";

/** The issued payslip PDF (stored at finalisation); drafts are rendered on the fly with a DRAFT watermark. */
export const GET = acct<{ id: string }>("accounting.payroll", async ({ auth, params }) => {
  const r = await payslipPdf(auth.organisationId, uuid(params.id, "Payslip"));
  return new Response(new Uint8Array(r.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store" } });
});
