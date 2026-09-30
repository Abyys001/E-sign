import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { setReady } from "@/server/contracts/service";

export const POST = authed<{ id: string }>("contracts.edit", async ({ req, auth, ctx, params }) => {
  const { ready } = await body(req, z.object({ ready: z.boolean() }));
  const c = await tx((t) => setReady(t, actorOf(auth, ctx), uuid(params.id, "Contract"), ready));
  return { status: c.status };
});
