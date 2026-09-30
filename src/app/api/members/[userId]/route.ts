import { z } from "zod";
import { authed, body } from "@/server/http";
import { tx, uuid, requireElevation } from "@/server/api";
import { PERMISSIONS } from "@/server/rbac";
import { removeMember, updateMember } from "@/server/orgs";

const P = z.object({ roleKey: z.string().optional(), grants: z.array(z.enum(PERMISSIONS)).optional(), denies: z.array(z.enum(PERMISSIONS)).optional() });

export const PATCH = authed<{ userId: string }>("users.manage", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, P);
  await tx((t) => updateMember(t, auth.organisationId, auth.user.id, uuid(params.userId, "Member"), b, ctx));
  return { ok: true };
});
export const DELETE = authed<{ userId: string }>("users.manage", async ({ auth, ctx, params }) => {
  requireElevation(auth);
  await tx((t) => removeMember(t, auth.organisationId, auth.user.id, uuid(params.userId, "Member"), ctx));
  return { ok: true };
});
