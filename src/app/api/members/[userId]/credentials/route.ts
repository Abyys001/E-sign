import { z } from "zod";
import { authed, body } from "@/server/http";
import { tx, uuid, requireElevation } from "@/server/api";
import { setMemberCredentials } from "@/server/orgs";

const P = z.object({ username: z.string().trim().max(64).nullable().optional(), password: z.string().min(1).max(200).optional() });

/** Set a member's username and/or a new password. The password is never returned or logged. */
export const PATCH = authed<{ userId: string }>("users.manage", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, P);
  const r = await tx((t) => setMemberCredentials(t, auth.organisationId, { id: auth.user.id, roleKey: auth.membership.roleKey, isSuperAdmin: auth.user.isSuperAdmin, sessionId: auth.sessionId }, uuid(params.userId, "Member"), b, ctx));
  return { ok: true, username: r.username };
});
