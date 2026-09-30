import { z } from "zod";
import { authed, query } from "@/server/http";
import { Pagination, uuid } from "@/server/api";
import { can } from "@/server/rbac";
import { listSessions } from "@/server/intake/activity";

const Filter = Pagination.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), invitationId: z.string().uuid().optional(), browser: z.string().max(40).optional(), os: z.string().max(40).optional(), deviceType: z.enum(["desktop", "mobile", "tablet", "unknown"]).optional(), ip: z.string().max(45).optional(), sessionId: z.string().uuid().optional(), type: z.string().max(60).optional(), status: z.enum(["active"]).optional() });

export const GET = authed<{ id: string }>("intake.view", async ({ req, auth, params }) => listSessions(auth.organisationId, uuid(params.id, "Form"), query(req, Filter), { telemetry: can(auth.membership, "intake.telemetry") }));
