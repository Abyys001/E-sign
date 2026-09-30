import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx } from "@/server/api";
import { createClauseDraft } from "@/server/clauses/service";
import { ConditionSchema } from "@/server/clauses/condition";

export const POST = authed("templates.edit", async ({ req, auth, ctx }) => {
  const b = await body(req, z.object({ clauseKey: z.string().regex(/^[a-z0-9_.]{3,120}$/), body: z.string().min(1).max(20000), jurisdiction: z.string().max(20).optional(), language: z.enum(["en", "fa"]).optional(), condition: ConditionSchema.nullish(), category: z.string().max(60).optional(), title: z.string().max(200).optional(), module: z.string().max(40).optional(), summary: z.string().max(500).optional() }));
  return Response.json(await tx((t) => createClauseDraft(t, actorOf(auth, ctx), b)), { status: 201 });
});
