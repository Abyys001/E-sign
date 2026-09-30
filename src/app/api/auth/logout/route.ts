import { audit } from "@/server/audit";
import { db } from "@/db";
import { destroySession } from "@/server/auth/session";
import { authed } from "@/server/http";

export const POST = authed(null, async ({ auth, ctx }) => {
  await db.transaction((tx) => audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "auth.logout", ctx }));
  await destroySession();
  return { ok: true };
});
