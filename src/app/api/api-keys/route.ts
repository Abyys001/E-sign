import { and, desc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { sha256 } from "@/server/crypto";
import { authed, body } from "@/server/http";
import { uuid, requireElevation } from "@/server/api";
import { PERMISSIONS, can } from "@/server/rbac";
import { AppError } from "@/server/errors";

export const GET = authed("settings.manage", async ({ auth }) => ({
  keys: await db.select({ id: schema.apiKeys.id, name: schema.apiKeys.name, prefix: schema.apiKeys.prefix, permissions: schema.apiKeys.permissions, lastUsedAt: schema.apiKeys.lastUsedAt, createdAt: schema.apiKeys.createdAt }).from(schema.apiKeys).where(and(eq(schema.apiKeys.organisationId, auth.organisationId), isNull(schema.apiKeys.revokedAt))).orderBy(desc(schema.apiKeys.createdAt)),
}));

export const POST = authed("settings.manage", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(80), permissions: z.array(z.enum(PERMISSIONS)).min(1) }));
  // A key can never carry a permission its creator lacks.
  const bad = b.permissions.filter((p) => !can(auth.membership, p));
  if (bad.length) throw new AppError("forbidden", `You cannot grant: ${bad.join(", ")}`);
  const prefix = randomBytes(5).toString("hex");
  const secret = `bes_live_${prefix}_${randomBytes(24).toString("base64url")}`;
  const [k] = await db.transaction(async (tx) => {
    const r = await tx.insert(schema.apiKeys).values({ organisationId: auth.organisationId, createdBy: auth.user.id, name: b.name, prefix, keyHash: sha256(secret), permissions: b.permissions }).returning({ id: schema.apiKeys.id });
    await audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "apikey.created", ctx, metadata: { name: b.name, permissions: b.permissions } });
    return r;
  });
  return Response.json({ id: k!.id, key: secret, note: "Store this key now. It cannot be shown again." }, { status: 201 });
});

export const DELETE = authed("settings.manage", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  const id = uuid(req.nextUrl.searchParams.get("id") ?? "", "API key");
  await db.transaction(async (tx) => {
    await tx.update(schema.apiKeys).set({ revokedAt: new Date() }).where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.organisationId, auth.organisationId)));
    await audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "apikey.revoked", ctx, metadata: { id } });
  });
  return { ok: true };
});
