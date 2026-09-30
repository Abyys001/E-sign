import { authed, } from "@/server/http";
import { actorOf, requireElevation, tx, uuid } from "@/server/api";
import { revealLink } from "@/server/intake/invitations";

export const POST = authed<{ id: string }>("intake.send", async ({ auth, ctx, params }) => { requireElevation(auth); return tx((t) => revealLink(t, actorOf(auth, ctx), uuid(params.id, "Invitation"))); });
