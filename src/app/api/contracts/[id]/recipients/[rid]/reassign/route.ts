import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid, requireElevation } from "@/server/api";
import { reassignRecipient } from "@/server/contracts/service";

export const POST = authed<{ id: string; rid: string }>("contracts.override", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email(), phone: z.string().regex(/^\+[1-9]\d{6,14}$/).nullish() }));
  await tx((t) => reassignRecipient(t, actorOf(auth, ctx), uuid(params.id, "Contract"), uuid(params.rid, "Recipient"), b));
  return { ok: true };
});
