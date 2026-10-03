import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { remittancePdf } from "@/server/accounting/remittance";

/** Payment receipt (remittance advice) PDF to send to the organiser. */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => {
  const r = await remittancePdf(auth.organisationId, uuid(params.id, "Payment"));
  return new Response(new Uint8Array(r.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store" } });
});
