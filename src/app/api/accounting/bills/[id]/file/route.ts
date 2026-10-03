import { Readable } from "node:stream";
import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { storage } from "@/server/storage";
import { attachBillFile, billFile } from "@/server/accounting/books";

export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => {
  const r = await billFile(auth.organisationId, uuid(params.id, "Document"));
  const stream = Readable.toWeb(await storage().getStream(r.key)) as ReadableStream;
  return new Response(stream, { headers: { "content-type": r.type, "content-disposition": `attachment; filename="${(r.name ?? "invoice").replace(/[^\w.\- ]/g, "_")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});

/** Upload the invoice / receipt (multipart field `file`). */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the file as multipart/form-data."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_failed", "Choose a file.", [{ path: "file", message: "Required" }]);
  return attachBillFile({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Document"), Buffer.from(await file.arrayBuffer()), file.name);
});
