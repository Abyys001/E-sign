import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { resendToRecipient } from "@/server/contracts/service";

export const POST = authed<{ id: string; rid: string }>("contracts.send", async ({ auth, ctx, params }) => {
  await tx((t) => resendToRecipient(t, actorOf(auth, ctx), uuid(params.id, "Contract"), uuid(params.rid, "Recipient")));
  return { ok: true };
});
