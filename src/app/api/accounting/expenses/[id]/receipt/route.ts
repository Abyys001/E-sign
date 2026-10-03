import { Readable } from "node:stream";
import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { storage } from "@/server/storage";
import { attachReceipt, receiptFor } from "@/server/accounting/expenses";

/** Download the receipt (always as an attachment, never rendered inline). */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => {
  const r = await receiptFor(auth.organisationId, uuid(params.id, "Expense"));
  const stream = Readable.toWeb(await storage().getStream(r.key)) as ReadableStream;
  return new Response(stream, { headers: { "content-type": r.type, "content-disposition": `attachment; filename="${(r.name ?? "receipt").replace(/[^\w.\- ]/g, "_")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});

/** Upload (multipart field `file`) a receipt for the expense. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the receipt as multipart/form-data."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_failed", "Choose a file.", [{ path: "file", message: "Required" }]);
  return attachReceipt({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Expense"), Buffer.from(await file.arrayBuffer()), file.name);
});
