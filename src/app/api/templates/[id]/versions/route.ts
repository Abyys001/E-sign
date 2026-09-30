import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { createDraftVersion } from "@/server/templates/service";

export const POST = authed<{ id: string }>("templates.edit", async ({ auth, ctx, params }) => {
  const v = await tx((t) => createDraftVersion(t, actorOf(auth, ctx), uuid(params.id, "Template")));
  return Response.json({ version: v.version }, { status: 201 });
});
