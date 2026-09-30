import { authed } from "@/server/http";
import { uuid } from "@/server/api";
import { can } from "@/server/rbac";
import { invitationActivity } from "@/server/intake/activity";

export const GET = authed<{ id: string }>("intake.view", async ({ auth, params }) => invitationActivity(auth.organisationId, uuid(params.id, "Invitation"), { telemetry: can(auth.membership, "intake.telemetry") }));
