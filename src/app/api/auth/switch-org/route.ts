import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { body, authed } from "@/server/http";
import { assertMember } from "@/server/orgs";

export const POST = authed(null, async ({ req, auth }) => {
  const { organisationId } = await body(req, z.object({ organisationId: z.string().uuid() }));
  await assertMember(auth.user.id, auth.user.isSuperAdmin, organisationId);
  await db.update(schema.sessions).set({ activeOrganisationId: organisationId, elevatedUntil: null }).where(eq(schema.sessions.id, auth.sessionId));
  return { ok: true };
});
