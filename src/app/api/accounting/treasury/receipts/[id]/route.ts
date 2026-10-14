import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { adminReceipt } from "@/server/treasury/admin";
import { Readable } from "node:stream";
export const GET = acct<{ id: string }>("treasury.admin", async ({ auth, params }) => {
  const r = await adminReceipt(auth.organisationId, uuid(params.id, "Receipt"));
  return new Response(Readable.toWeb(r.stream) as ReadableStream, { headers: { "content-type": r.contentType, "content-disposition": `inline; filename="${r.name.replace(/[^A-Za-z0-9_.-]/g, "_")}"`, "cache-control": "private, no-store" } });
});
