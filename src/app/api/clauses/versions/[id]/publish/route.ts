import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { publishClauseVersion } from "@/server/clauses/service";

export const POST = authed<{ id: string }>("templates.edit", async ({ auth, ctx, params }) => tx((t) => publishClauseVersion(t, actorOf(auth, ctx), uuid(params.id, "Clause version"))));
