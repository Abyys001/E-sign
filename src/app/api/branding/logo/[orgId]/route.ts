import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppError } from "@/server/errors";
import { open } from "@/server/http";
import { uuid } from "@/server/api";
import { storage } from "@/server/storage";
import { BrandingSchema } from "@/server/settings/schema";

/** Public: an organisation's logo is shown on its signing pages. Only that one image is reachable, by organisation id. */
export const GET = open<{ orgId: string }>(async ({ params }) => {
  const [o] = await db.select({ b: schema.organisations.branding }).from(schema.organisations).where(eq(schema.organisations.id, uuid(params.orgId, "Logo")));
  const id = o ? BrandingSchema.parse(o.b).logoObjectId : null;
  if (!id) throw new AppError("not_found", "No logo");
  const [obj] = await db.select().from(schema.storageObjects).where(eq(schema.storageObjects.id, id));
  if (!obj || obj.organisationId !== params.orgId) throw new AppError("not_found", "No logo");
  return new Response(new Uint8Array(await storage().getBuffer(obj.key)), { headers: { "content-type": obj.contentType, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
});
