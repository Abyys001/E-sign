import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { Pagination } from "@/server/api";
import { createOrganiser, OrganiserInput, organiserView } from "@/server/accounting/entities";
import { listOrganisers } from "@/server/accounting/queries";

const Q = Pagination.extend({ q: z.string().trim().max(120).optional(), active: z.enum(["true", "false"]).optional() }).passthrough();

export const GET = acct("accounting.view", async ({ req, auth }) => {
  const q = query(req, Q);
  return { ...(await listOrganisers(auth.organisationId, { q: q.q, active: q.active === undefined ? undefined : q.active === "true" }, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize };
});

/** Organisers are created by an administrator only — never automatically from Stripe customers. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) =>
  organiserView(await createOrganiser({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, OrganiserInput))));
