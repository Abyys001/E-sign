import { authed, query } from "@/server/http";
import { Pagination, uuid } from "@/server/api";
import { can } from "@/server/rbac";
import { listDevices } from "@/server/intake/activity";

export const GET = authed<{ id: string }>("intake.view", async ({ req, auth, params }) => listDevices(auth.organisationId, uuid(params.id, "Form"), query(req, Pagination), { telemetry: can(auth.membership, "intake.telemetry") }));
