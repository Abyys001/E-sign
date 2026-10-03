import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { linkOrganiserUser, organiserUsers, unlinkOrganiserUser } from "@/server/accounting/portal";

const B = z.object({ userId: z.string().uuid() });

/** Users who can see this organiser's own figures in the organiser portal. */
export const GET = acct<{ id: string }>("accounting.admin", async ({ auth, params }) => organiserUsers(auth.organisationId, uuid(params.id, "Organiser")));
export const POST = acct<{ id: string }>("accounting.admin", async ({ req, auth, ctx, params }) => linkOrganiserUser({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Organiser"), (await body(req, B)).userId));
export const DELETE = acct<{ id: string }>("accounting.admin", async ({ req, auth, ctx, params }) => unlinkOrganiserUser({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Organiser"), (await body(req, B)).userId));
