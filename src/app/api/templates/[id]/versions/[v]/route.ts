import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { updateDraftVersion } from "@/server/templates/service";

const B = z.object({ name: z.string().trim().min(1).max(200).optional(), contractType: z.string().trim().min(1).max(60).optional(), variables: z.array(z.unknown()).optional(), fields: z.array(z.unknown()).max(500).optional(), recipientRoles: z.array(z.unknown()).optional() });
export const PATCH = authed<{ id: string; v: string }>("templates.edit", async ({ req, auth, ctx, params }) => {
  const b = await body(req, B);
  const v = await tx((t) => updateDraftVersion(t, actorOf(auth, ctx), uuid(params.id, "Template"), Number(params.v), b));
  return { version: v.version };
});
