import { and, eq } from "drizzle-orm";
import { authed } from "@/server/http";
import { db, schema } from "@/db";
import { uuid } from "@/server/api";
import { notFound } from "@/server/errors";
import { audit } from "@/server/audit";
import { storage } from "@/server/storage";
import { safeDownloadName } from "@/server/storage/keys";

/** Organiser-uploaded documents: tenant-scoped, audited, always downloaded as an attachment. */
export const GET = authed<{ id: string }>("intake.view", async ({ auth, ctx, params }) => {
  const [f] = await db.select({ f: schema.intakeFiles, key: schema.storageObjects.key }).from(schema.intakeFiles).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.intakeFiles.storageObjectId))
    .where(and(eq(schema.intakeFiles.id, uuid(params.id, "File")), eq(schema.intakeFiles.organisationId, auth.organisationId)));
  if (!f) throw notFound("File");
  await db.transaction((tx) => audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "intake.file.downloaded", ctx, metadata: { fileId: f.f.id } }));
  const bytes = await storage().getBuffer(f.key);
  const ext = f.f.filename.split(".").pop() ?? "bin";
  return new Response(new Uint8Array(bytes), { headers: { "content-type": f.f.contentType, "content-disposition": `attachment; filename="${safeDownloadName(f.f.filename.replace(/\.[^.]+$/, ""), ext)}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
