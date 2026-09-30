import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { sendContract } from "@/server/contracts/service";

export const POST = authed<{ id: string }>("contracts.send", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ expiresAt: z.coerce.date().nullish() }));
  return tx((t) => sendContract(t, actorOf(auth, ctx), uuid(params.id, "Contract"), { expiresAt: b.expiresAt ?? null, idempotencyKey: req.headers.get("idempotency-key") }));
});
