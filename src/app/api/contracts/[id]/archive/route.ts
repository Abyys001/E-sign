import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { archiveContract } from "@/server/contracts/service";

export const POST = authed<{ id: string }>("contracts.edit", async ({ auth, ctx, params }) => {
  const c = await tx((t) => archiveContract(t, actorOf(auth, ctx), uuid(params.id, "Contract")));
  return { status: c.status };
});
