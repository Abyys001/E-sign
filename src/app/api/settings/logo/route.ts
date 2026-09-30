import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppError } from "@/server/errors";
import { authed } from "@/server/http";
import { tx } from "@/server/api";
import { decodeImageDataUrl } from "@/server/signing/service";
import { storage } from "@/server/storage";
import { objectKey } from "@/server/storage/keys";
import { updateOrgBranding } from "@/server/settings";

/** Organisation logo: PNG/JPEG only (SVG can carry script), decoded and size-limited, stored privately, served by our own route. */
export const POST = authed("settings.manage", async ({ req, auth, ctx }) => {
  const form = await req.formData();
  const f = form.get("file");
  if (!(f instanceof File)) throw new AppError("validation_failed", "Choose an image.");
  const buf = Buffer.from(await f.arrayBuffer());
  const type = buf[0] === 0x89 ? "png" : buf[0] === 0xff ? "jpeg" : null;
  if (!type) throw new AppError("unsupported_media", "The logo must be a PNG or JPEG image.");
  await decodeImageDataUrl(`data:image/${type};base64,${buf.toString("base64")}`, { maxBytes: 600_000 });
  const id = await tx(async (t) => {
    const key = objectKey(auth.organisationId, "branding");
    const put = await storage().put(key, buf, `image/${type}`);
    const [o] = await t.insert(schema.storageObjects).values({ organisationId: auth.organisationId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: `image/${type}` }).returning();
    await updateOrgBranding(t, auth.organisationId, auth.user.id, { logoObjectId: o!.id }, ctx);
    return o!.id;
  });
  return { logoObjectId: id };
});
export const DELETE = authed("settings.manage", async ({ auth, ctx }) => { await tx((t) => updateOrgBranding(t, auth.organisationId, auth.user.id, { logoObjectId: null }, ctx)); return { ok: true }; });
export { and, eq, db };
