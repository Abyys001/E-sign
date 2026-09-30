import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid, requireElevation } from "@/server/api";
import { voidContract } from "@/server/contracts/service";

export const POST = authed<{ id: string }>("contracts.override", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ reason: z.string().trim().min(3).max(500) }));
  const c = await tx((t) => voidContract(t, actorOf(auth, ctx), uuid(params.id, "Contract"), b.reason));
  return { status: c.status };
});
