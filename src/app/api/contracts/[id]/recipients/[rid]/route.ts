import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { removeRecipient, updateRecipient } from "@/server/contracts/service";
import { RecipientBody } from "../route";

export const PATCH = authed<{ id: string; rid: string }>("contracts.edit", async ({ req, auth, ctx, params }) => {
  const b = await body(req, RecipientBody.partial());
  await tx((t) => updateRecipient(t, actorOf(auth, ctx), uuid(params.id, "Contract"), uuid(params.rid, "Recipient"), b));
  return { ok: true };
});
export const DELETE = authed<{ id: string; rid: string }>("contracts.edit", async ({ auth, ctx, params }) => {
  await tx((t) => removeRecipient(t, actorOf(auth, ctx), uuid(params.id, "Contract"), uuid(params.rid, "Recipient")));
  return { ok: true };
});
