import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { deleteTelemetry, exportTelemetry } from "@/server/intake/activity";

export const GET = authed<{ id: string }>("intake.telemetry", async ({ auth, params }) => exportTelemetry(auth.organisationId, uuid(params.id, "Invitation")));
// Erasure is a privacy-officer decision, so it also needs settings.manage via the elevated check in the service caller.
export const DELETE = authed<{ id: string }>("settings.manage", async ({ auth, ctx, params }) => tx((t) => deleteTelemetry(t, actorOf(auth, ctx), uuid(params.id, "Invitation"))));
