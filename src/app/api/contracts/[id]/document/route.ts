import { and, eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { db, schema } from "@/db";
import { AppError } from "@/server/errors";
import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { getContractRow, uploadVersion } from "@/server/contracts/service";
import { storage } from "@/server/storage";

/** Inline preview stream for the editor/viewer (no download audit: it is the same authorised user working on the draft). */
export const GET = authed<{ id: string }>("contracts.view", async ({ req, auth, params }) => {
  const c = await getContractRow(auth.organisationId, uuid(params.id, "Contract"));
  const vid = req.nextUrl.searchParams.get("version") ?? c.signingVersionId ?? c.currentVersionId;
  if (!vid) throw new AppError("not_found", "No document has been uploaded yet.");
  const [row] = await db.select({ key: schema.storageObjects.key, size: schema.storageObjects.sizeBytes, purged: schema.storageObjects.purgedAt, sha: schema.contractVersions.sha256 }).from(schema.contractVersions)
    .innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.contractVersions.storageObjectId))
    .where(and(eq(schema.contractVersions.id, uuid(vid, "Document")), eq(schema.contractVersions.contractId, c.id), eq(schema.contractVersions.organisationId, auth.organisationId)));
  if (!row) throw new AppError("not_found", "Document not found");
  if (row.purged) throw new AppError("gone", "This document was removed under the retention policy.");
  return new Response(Readable.toWeb(await storage().getStream(row.key)) as ReadableStream, { headers: { "content-type": "application/pdf", "content-length": String(row.size), "content-disposition": 'inline; filename="document.pdf"', "cache-control": "private, no-store", "x-content-type-options": "nosniff", etag: `"${row.sha}"` } });
});

export const POST = authed<{ id: string }>("contracts.edit", async ({ req, auth, ctx, params }) => {
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the PDF as multipart form data."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_failed", "Choose a PDF to upload.");
  const bytes = Buffer.from(await file.arrayBuffer()); // size/type are validated on the bytes, never on file.name or file.type
  const reason = typeof form.get("reason") === "string" ? String(form.get("reason")).slice(0, 300) : undefined;
  const v = await tx((t) => uploadVersion(t, actorOf(auth, ctx), uuid(params.id, "Contract"), bytes, reason));
  return Response.json({ versionId: v.id, version: v.version, pages: v.pageCount, sha256: v.sha256, pageGeometry: v.pageDims }, { status: 201 });
});
