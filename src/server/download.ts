import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit, type RequestContext } from "./audit";
import { AppError, notFound } from "./errors";
import { rateLimit } from "./rate-limit";
import { storage } from "./storage";
import { safeDownloadName } from "./storage/keys";

export type Artifact = "source" | "final" | "certificate";

/**
 * The single path every authorised document download goes through: tenant check, purge check, rate limit, a `downloads`
 * row and an audit event, then a streamed response (never a permanent public URL; S3 gets a 60-second presigned redirect).
 */
export async function serveArtifact(a: { orgId: string; contractId: string; artifact: Artifact; userId?: string | null; recipientId?: string | null; ctx: RequestContext; rateKey: string; inline?: boolean }) {
  await rateLimit("download", a.rateKey);
  const [c] = await db.select().from(schema.contracts).where(and(eq(schema.contracts.id, a.contractId), eq(schema.contracts.organisationId, a.orgId)));
  if (!c) throw notFound("Document");
  let objectId: string | null = null, hash: string | null = null, name = c.name;
  const ext = "pdf";
  if (a.artifact === "final") {
    if (!c.finalVersionId) throw new AppError("not_found", "The final document is not ready yet.");
    const [v] = await db.select().from(schema.contractVersions).where(and(eq(schema.contractVersions.id, c.finalVersionId), eq(schema.contractVersions.organisationId, a.orgId)));
    objectId = v?.storageObjectId ?? null; hash = v?.sha256 ?? null; name = `${c.name} - signed`;
  } else if (a.artifact === "certificate") {
    const [cert] = await db.select().from(schema.completionCertificates).where(and(eq(schema.completionCertificates.contractId, c.id), eq(schema.completionCertificates.organisationId, a.orgId)));
    if (!cert) throw new AppError("not_found", "The certificate is not ready yet.");
    objectId = cert.storageObjectId; hash = cert.finalDocumentHash; name = `${c.name} - certificate`;
  } else {
    const vid = c.signingVersionId ?? c.currentVersionId;
    const [v] = vid ? await db.select().from(schema.contractVersions).where(and(eq(schema.contractVersions.id, vid), eq(schema.contractVersions.organisationId, a.orgId))) : [];
    objectId = v?.storageObjectId ?? null; hash = v?.sha256 ?? null;
  }
  if (!objectId) throw notFound("Document");
  const [o] = await db.select().from(schema.storageObjects).where(and(eq(schema.storageObjects.id, objectId), eq(schema.storageObjects.organisationId, a.orgId)));
  if (!o) throw notFound("Document");
  if (o.purgedAt) throw new AppError("gone", "This document was removed under the organisation's retention policy.");
  await db.transaction(async (tx) => {
    await tx.insert(schema.downloads).values({ organisationId: a.orgId, contractId: c.id, userId: a.userId ?? null, recipientId: a.recipientId ?? null, artifact: a.artifact.toUpperCase(), ip: a.ctx.ip ?? null, userAgent: a.ctx.userAgent ?? null });
    await audit(tx, { organisationId: a.orgId, contractId: c.id, userId: a.userId ?? null, recipientId: a.recipientId ?? null, eventType: "document.downloaded", ctx: a.ctx, documentHash: hash, metadata: { artifact: a.artifact } });
  });
  const filename = safeDownloadName(name, ext);
  const signed = await storage().signedUrl(o.key, 60, filename);
  if (signed) return Response.redirect(signed, 302);
  const body = Readable.toWeb(await storage().getStream(o.key)) as ReadableStream;
  return new Response(body, { headers: { "content-type": "application/pdf", "content-length": String(o.sizeBytes), "content-disposition": `${a.inline ? "inline" : "attachment"}; filename="${filename}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-content-sha256": hash ?? "" } });
}
