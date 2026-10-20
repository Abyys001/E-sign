import { Readable } from "node:stream";
import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { storage } from "@/server/storage";
import { attachPaymentProof, attachWiseProof, paymentProofFor } from "@/server/accounting/payment-proof";

/** Download the proof of payment (always as an attachment, never rendered inline). */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => {
  const r = await paymentProofFor(auth.organisationId, uuid(params.id, "Payment"));
  const stream = Readable.toWeb(await storage().getStream(r.key)) as ReadableStream;
  return new Response(stream, { headers: { "content-type": r.type, "content-disposition": `attachment; filename="${(r.name ?? "proof-of-payment").replace(/[^\w.\- ]/g, "_")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});

/** Attach proof: multipart field `file`, or JSON `{ "wiseTransferId": "123" }` to fetch the Wise transfer confirmation. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const a = { orgId: auth.organisationId, userId: auth.user.id, ctx }, id = uuid(params.id, "Payment");
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = await req.json().catch(() => ({})) as { wiseTransferId?: string };
    return attachWiseProof(a, id, body.wiseTransferId ?? null);
  }
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the file as multipart/form-data."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_failed", "Choose a file.", [{ path: "file", message: "Required" }]);
  return attachPaymentProof(a, id, Buffer.from(await file.arrayBuffer()), file.name);
});
