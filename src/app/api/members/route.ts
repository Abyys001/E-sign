import { z } from "zod";
import { authed, body } from "@/server/http";
import { requireElevation, tx } from "@/server/api";
import { ASSIGNABLE_ROLES, createMemberWithPassword, inviteMember, listMembers } from "@/server/orgs";
import { SYSTEM_ROLES, PERMISSIONS } from "@/server/rbac";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

export const GET = authed("users.manage", async ({ auth }) => ({
  members: (await listMembers(auth.organisationId)).map(({ hasTotp, lockedUntil, otherOrgs, isSuperAdmin, ...m }) => ({
    ...m, hasTotp: !!hasTotp, locked: !!lockedUntil && lockedUntil > new Date(),
    // Whether this org's admins may set the person's username/password (see setMemberCredentials for the rules).
    credentialsManaged: !isSuperAdmin && (otherOrgs === 0 || auth.user.isSuperAdmin),
  })),
  roles: ASSIGNABLE_ROLES.map((k) => ({ key: k, name: SYSTEM_ROLES[k]!.name, permissions: SYSTEM_ROLES[k]!.permissions })),
  permissions: PERMISSIONS,
}));

const Invite = z.object({ email: z.string().trim().email().max(254), name: z.string().trim().min(1).max(120), roleKey: z.string(), locale: z.enum(["en", "fa"]).optional() });
const WithPassword = Invite.extend({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) });

/** Invite by email (the person picks their own password), or — when `username` + `password` are given — create the login directly. */
export const POST = authed("users.manage", async ({ req, auth, ctx }) => {
  const b = await body(req, z.union([WithPassword, Invite]));
  if ("password" in b) {
    requireElevation(auth);
    const u = await tx((t) => createMemberWithPassword(t, auth.organisationId, auth.user.id, b, ctx));
    return Response.json({ userId: u.id, username: u.username, invited: false }, { status: 201 });
  }
  const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, auth.user.id));
  const r = await tx((t) => inviteMember(t, auth.organisationId, { id: auth.user.id, name: me?.name ?? "" }, b, ctx));
  return Response.json({ userId: r.user.id, invited: r.invited }, { status: 201 });
});
