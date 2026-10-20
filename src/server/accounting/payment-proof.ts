import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { assertClean } from "../scan";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { acctAudit } from "./core";
import { RECEIPT_TYPES } from "./expenses";
import { wiseTransferReceipt } from "./wise";

/**
 * Proof of payment for organiser payments (the bank's transfer confirmation). A payment split across events is several
 * records with one reference: the proof is attached to all of them at once.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };

export async function attachPaymentProof(a: Actor, id: string, bytes: Buffer, fileName: string, source = "upload") {
  const cap = Math.min(10, env().MAX_UPLOAD_MB) * 1024 * 1024;
  if (!bytes.length) throw new AppError("validation_failed", "The file is empty.");
  if (bytes.length > cap) throw new AppError("payload_too_large", `The file is too large. The maximum is ${Math.floor(cap / 1048576)} MB.`);
  const kind = RECEIPT_TYPES.find((t) => t.test(bytes));
  if (!kind) throw new AppError("unsupported_media", "Proof of payment must be a PDF, PNG, JPEG or WebP file.");
  await assertClean(bytes);
  const p = schema.acctOrganiserPayments;
  const [pay] = await db.select().from(p).where(and(eq(p.id, id), eq(p.organisationId, a.orgId)));
  if (!pay) throw new AppError("not_found", "Payment not found");
  if (pay.status === "VOIDED") throw new AppError("invalid_state", "A voided payment cannot get a proof of payment.");
  const key = objectKey(a.orgId, "payment-proof");
  const put = await storage().put(key, bytes, kind.type);
  return db.transaction(async (tx) => {
    const [obj] = await tx.insert(schema.storageObjects).values({ organisationId: a.orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: kind.type }).returning();
    const name = `${fileName.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\.[^.]*$/, "").trim().slice(0, 80) || "proof-of-payment"}.${kind.ext}`;
    const sameRef = pay.bankReference
      ? (await tx.select({ id: p.id }).from(p).where(and(eq(p.organisationId, a.orgId), eq(p.organiserId, pay.organiserId), eq(p.bankReference, pay.bankReference), eq(p.currency, pay.currency), inArray(p.status, ["PAID", "PENDING"])))).map((x) => x.id)
      : [id];
    const rows = await tx.update(p).set({ proofObjectId: obj!.id, proofName: name, updatedBy: a.userId, updatedAt: new Date() }).where(inArray(p.id, sameRef)).returning();
    for (const r of rows) await acctAudit(tx, { ...a, action: pay.proofObjectId ? "organiser_payment.proof_replaced" : "organiser_payment.proof_added", entity: "organiser_payment", entityId: r.id, new: { proof: name, sha256: put.sha256, bytes: put.sizeBytes, source }, extra: { reference: pay.bankReference } });
    return { proofName: name, payments: rows.map((r) => r.id) };
  });
}

/** Fetch the Wise transfer confirmation and attach it. The transfer number comes from the input or a "Wise #123" reference. */
export async function attachWiseProof(a: Actor, id: string, wiseTransferId?: string | null) {
  const p = schema.acctOrganiserPayments;
  const [pay] = await db.select({ ref: p.bankReference }).from(p).where(and(eq(p.id, id), eq(p.organisationId, a.orgId)));
  if (!pay) throw new AppError("not_found", "Payment not found");
  const tid = (wiseTransferId ?? "").trim() || pay.ref?.match(/wise\s*#?\s*(\d{5,15})/i)?.[1] || "";
  if (!tid) throw new AppError("validation_failed", "Enter the Wise transfer number.", [{ path: "wiseTransferId", message: "Required" }]);
  return attachPaymentProof(a, id, await wiseTransferReceipt(a.orgId, tid), `wise-transfer-${tid}`, `wise:${tid}`);
}

export async function paymentProofFor(orgId: string, id: string) {
  const p = schema.acctOrganiserPayments;
  const [r] = await db.select({ key: schema.storageObjects.key, type: schema.storageObjects.contentType, name: p.proofName })
    .from(p).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, p.proofObjectId))
    .where(and(eq(p.id, id), eq(p.organisationId, orgId), eq(schema.storageObjects.organisationId, orgId)));
  if (!r) throw new AppError("not_found", "No proof of payment attached");
  return r;
}
