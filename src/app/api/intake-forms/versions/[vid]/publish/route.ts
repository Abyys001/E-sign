import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { publishFormVersion } from "@/server/intake/forms";

export const POST = authed<{ vid: string }>("intake.manage", async ({ auth, ctx, params }) => tx((t) => publishFormVersion(t, actorOf(auth, ctx), uuid(params.vid, "Form version"))));
