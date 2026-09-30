import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { updateClauseDraft } from "@/server/clauses/service";
import { ConditionSchema } from "@/server/clauses/condition";

export const PATCH = authed<{ id: string }>("templates.edit", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ body: z.string().min(1).max(20000).optional(), condition: ConditionSchema.nullish() }));
  return tx((t) => updateClauseDraft(t, actorOf(auth, ctx), uuid(params.id, "Clause version"), b));
});
