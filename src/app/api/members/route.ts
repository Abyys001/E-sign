import { z } from "zod";
import { authed, body } from "@/server/http";
import { tx } from "@/server/api";
import { ASSIGNABLE_ROLES, inviteMember, listMembers } from "@/server/orgs";
import { SYSTEM_ROLES, PERMISSIONS } from "@/server/rbac";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

export const GET = authed("users.manage", async ({ auth }) => ({
  members: (await listMembers(auth.organisationId)).map((m) => ({ ...m, hasTotp: !!m.hasTotp })),
  roles: ASSIGNABLE_ROLES.map((k) => ({ key: k, name: SYSTEM_ROLES[k]!.name, permissions: SYSTEM_ROLES[k]!.permissions })),
  permissions: PERMISSIONS,
}));

export const POST = authed("users.manage", async ({ req, auth, ctx }) => {
  const b = await body(req, z.object({ email: z.string().trim().email().max(254), name: z.string().trim().min(1).max(120), roleKey: z.string(), locale: z.enum(["en", "fa"]).optional() }));
  const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, auth.user.id));
  const r = await tx((t) => inviteMember(t, auth.organisationId, { id: auth.user.id, name: me?.name ?? "" }, b, ctx));
  return Response.json({ userId: r.user.id, invited: r.invited }, { status: 201 });
});
