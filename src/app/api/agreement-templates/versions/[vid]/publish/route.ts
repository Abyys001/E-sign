import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { publishAgreementVersion } from "@/server/agreements/service";

export const POST = authed<{ vid: string }>("templates.edit", async ({ auth, ctx, params }) => tx((t) => publishAgreementVersion(t, actorOf(auth, ctx), uuid(params.vid, "Template version"))));
