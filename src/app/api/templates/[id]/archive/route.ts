import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { setTemplateArchived } from "@/server/templates/service";

export const POST = authed<{ id: string }>("templates.edit", async ({ req, auth, ctx, params }) => {
  const { archived } = await body(req, z.object({ archived: z.boolean().default(true) }));
  await tx((t) => setTemplateArchived(t, actorOf(auth, ctx), uuid(params.id, "Template"), archived));
  return { ok: true };
});
