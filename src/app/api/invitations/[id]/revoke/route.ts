import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { revokeInvitation } from "@/server/intake/invitations";

export const POST = authed<{ id: string }>("intake.send", async ({ auth, ctx, params }) => { await tx((t) => revokeInvitation(t, actorOf(auth, ctx), uuid(params.id, "Invitation"))); return { ok: true }; });
