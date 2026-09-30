import { authed } from "@/server/http";
import { actorOf, tx } from "@/server/api";
import { seedClauseLibrary } from "@/server/clauses/service";

export const POST = authed("templates.edit", async ({ auth, ctx }) => tx((t) => seedClauseLibrary(t, actorOf(auth, ctx))));
