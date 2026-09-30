import { z } from "zod";
import { authed, body } from "@/server/http";
import { markRead } from "@/server/notifications";

export const POST = authed(null, async ({ req, auth }) => {
  const b = await body(req, z.object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() }));
  await markRead(auth.organisationId, auth.user.id, b.all ? "all" : b.ids ?? []);
  return { ok: true };
});
