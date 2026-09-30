import { authed } from "@/server/http";
import { actorOf, tx, uuid, requireElevation } from "@/server/api";
import { expireContract } from "@/server/contracts/service";

export const POST = authed<{ id: string }>("contracts.override", async ({ auth, ctx, params }) => {
  requireElevation(auth);
  const c = await tx((t) => expireContract(t, actorOf(auth, ctx), uuid(params.id, "Contract")));
  return { status: c.status };
});
