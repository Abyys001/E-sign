import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { cancelContract } from "@/server/contracts/service";

export const POST = authed<{ id: string }>("contracts.cancel", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ reason: z.string().max(500).optional() }));
  const c = await tx((t) => cancelContract(t, actorOf(auth, ctx), uuid(params.id, "Contract"), b.reason));
  return { status: c.status };
});
