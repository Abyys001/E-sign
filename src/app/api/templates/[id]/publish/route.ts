import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { publishVersion } from "@/server/templates/service";

export const POST = authed<{ id: string }>("templates.edit", async ({ req, auth, ctx, params }) => {
  const { version } = await body(req, z.object({ version: z.number().int().min(1) }));
  const v = await tx((t) => publishVersion(t, actorOf(auth, ctx), uuid(params.id, "Template"), version));
  return { version: v.version, published: v.published };
});
