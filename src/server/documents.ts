import { and, desc, eq } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "./audit";
import { AppError } from "./errors";
import { env } from "@/lib/env";
import { sha256Bytes } from "./kit/pdf/hash";
import { PdfLimitError } from "./kit/pdf/limits";
import { PdfRejectedError, assertSafeToProcess, type PdfInspection } from "./kit/pdf/pdf-inspect";
import { assertClean } from "./scan";
import { storage } from "./storage";
import { objectKey } from "./storage/keys";
import { getOrgSettings } from "./settings";

export type PdfMeta = { pageCount: number; pageDims: Array<{ box: [number, number, number, number]; rotate: number }> };

/** Validate an uploaded file by content, never by client-supplied name or MIME. */
export async function validatePdfUpload(bytes: Buffer, maxMb: number): Promise<{ info: PdfInspection; sha256: string }> {
  const cap = Math.min(maxMb, env().MAX_UPLOAD_MB) * 1024 * 1024;
  if (bytes.length === 0) throw new AppError("validation_failed", "The file is empty.");
  if (bytes.length > cap) throw new AppError("payload_too_large", `The file is too large. The maximum is ${Math.floor(cap / 1048576)} MB.`);
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new AppError("unsupported_media", "Only PDF files are supported.");
  await assertClean(bytes);
  try {
    const info = await Promise.race([
      assertSafeToProcess(bytes, { maxBytes: cap, maxPages: env().MAX_PDF_PAGES }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new AppError("unsupported_media", "The PDF took too long to process.")), 20_000)),
    ]);
    if (info.pageCount < 1) throw new AppError("unsupported_media", "The PDF has no pages.");
    return { info, sha256: sha256Bytes(bytes) };
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof PdfRejectedError) {
      const enc = e.reasons.includes("encrypted");
      throw new AppError("unsupported_media", enc ? "Password-protected PDFs are not supported. Remove the password and upload again." : "This PDF contains active content (scripts, launch actions or embedded files) and cannot be used.");
    }
    if (e instanceof PdfLimitError) throw new AppError("payload_too_large", e.kind === "pages" ? `The PDF has too many pages (limit ${env().MAX_PDF_PAGES}).` : "The file is too large.");
    throw new AppError("unsupported_media", "This file is not a valid PDF or is damaged.");
  }
}

/** Store bytes as a new contract version. Locked/frozen contracts cannot receive new versions. */
export async function addContractVersion(tx: Tx, a: { orgId: string; contractId: string; userId: string; bytes: Buffer; reason?: string; ctx: RequestContext; info?: PdfInspection; kind?: "SOURCE" | "FINAL" }) {
  const settings = await getOrgSettings(a.orgId, tx);
  const { info, sha256 } = a.info ? { info: a.info, sha256: sha256Bytes(a.bytes) } : await validatePdfUpload(a.bytes, settings.security.maxUploadMb);
  const key = objectKey(a.orgId, a.kind === "FINAL" ? "final" : "source");
  const put = await storage().put(key, a.bytes, "application/pdf");
  const [obj] = await tx.insert(schema.storageObjects).values({ organisationId: a.orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: "application/pdf" }).returning();
  const [last] = await tx.select({ v: schema.contractVersions.version }).from(schema.contractVersions)
    .where(and(eq(schema.contractVersions.contractId, a.contractId), eq(schema.contractVersions.kind, a.kind ?? "SOURCE"))).orderBy(desc(schema.contractVersions.version)).limit(1);
  const [ver] = await tx.insert(schema.contractVersions).values({
    contractId: a.contractId, organisationId: a.orgId, version: (last?.v ?? 0) + 1, kind: a.kind ?? "SOURCE", storageObjectId: obj!.id,
    sha256, pageCount: info.pageCount, pageDims: info.pages, changeReason: a.reason ?? null, createdBy: a.userId,
  }).returning();
  await audit(tx, { organisationId: a.orgId, contractId: a.contractId, userId: a.userId, eventType: "document.version_created", ctx: a.ctx, documentHash: sha256, metadata: { version: ver!.version, pages: info.pageCount, bytes: put.sizeBytes, reason: a.reason ?? null } });
  return ver!;
}

export async function loadVersionBytes(orgId: string, versionId: string): Promise<Buffer> {
  const [row] = await db.select({ key: schema.storageObjects.key, orgId: schema.storageObjects.organisationId })
    .from(schema.contractVersions).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.contractVersions.storageObjectId))
    .where(and(eq(schema.contractVersions.id, versionId), eq(schema.contractVersions.organisationId, orgId)));
  if (!row || row.orgId !== orgId) throw new AppError("not_found", "Document not found");
  return storage().getBuffer(row.key);
}
