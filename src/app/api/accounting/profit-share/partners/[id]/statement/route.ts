import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { partnerStatementPdf } from "@/server/accounting/profit-share";

export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params, mode }) => {
  const r = await partnerStatementPdf(auth.organisationId, mode, uuid(params.id, "Partner"));
  return new Response(new Uint8Array(r.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store" } });
});
