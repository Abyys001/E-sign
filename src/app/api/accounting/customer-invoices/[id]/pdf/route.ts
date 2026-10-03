import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { invoicePdf } from "@/server/accounting/invoices";

export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => {
  const r = await invoicePdf(auth.organisationId, uuid(params.id, "Invoice"));
  return new Response(new Uint8Array(r.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store" } });
});
