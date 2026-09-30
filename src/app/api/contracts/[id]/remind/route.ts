import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { remindRecipient } from "@/server/contracts/service";

export const POST = authed<{ id: string }>("contracts.remind", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ recipientId: z.string().uuid().optional() }));
  return { reminded: await tx((t) => remindRecipient(t, actorOf(auth, ctx), uuid(params.id, "Contract"), b.recipientId)) };
});
