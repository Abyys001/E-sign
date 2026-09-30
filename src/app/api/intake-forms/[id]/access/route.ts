import { authed } from "@/server/http";
import { uuid } from "@/server/api";
import { can } from "@/server/rbac";
import { formAccessSummary } from "@/server/intake/activity";

export const GET = authed<{ id: string }>("intake.view", async ({ auth, params }) => formAccessSummary(auth.organisationId, uuid(params.id, "Form"), { telemetry: can(auth.membership, "intake.telemetry") }));
