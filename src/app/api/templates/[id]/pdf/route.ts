import { and, eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { db, schema } from "@/db";
import { AppError } from "@/server/errors";
import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { storage } from "@/server/storage";
import { updateDraftVersion } from "@/server/templates/service";

export const GET = authed<{ id: string }>("templates.view", async ({ req, auth, params }) => {
  const id = uuid(params.id, "Template");
  const v = Number(req.nextUrl.searchParams.get("version") ?? 0);
  const [row] = await db.select({ key: schema.storageObjects.key, size: schema.storageObjects.sizeBytes }).from(schema.templateVersions).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.templateVersions.storageObjectId))
    .where(and(eq(schema.templateVersions.templateId, id), eq(schema.templateVersions.organisationId, auth.organisationId), v ? eq(schema.templateVersions.version, v) : undefined)).orderBy(schema.templateVersions.version);
  if (!row) throw new AppError("not_found", "No document for this template yet.");
  return new Response(Readable.toWeb(await storage().getStream(row.key)) as ReadableStream, { headers: { "content-type": "application/pdf", "content-length": String(row.size), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});

/** Replace the PDF on the current DRAFT version. */
export const PUT = authed<{ id: string }>("templates.edit", async ({ req, auth, ctx, params }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_failed", "Choose a PDF.");
  const version = Number(form.get("version"));
  const bytes = Buffer.from(await file.arrayBuffer());
  await tx((t) => updateDraftVersion(t, actorOf(auth, ctx), uuid(params.id, "Template"), version, { pdf: bytes }));
  return { ok: true };
});
