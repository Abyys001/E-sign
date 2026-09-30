import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { saveFields } from "@/server/contracts/service";

export const PUT = authed<{ id: string }>("contracts.edit", async ({ req, auth, ctx, params }) => {
  const { fields } = await body(req, z.object({ fields: z.array(z.unknown()).max(500) }));
  const n = await tx((t) => saveFields(t, actorOf(auth, ctx), uuid(params.id, "Contract"), fields));
  return { saved: n };
});
