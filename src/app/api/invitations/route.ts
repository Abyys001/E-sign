import { authed, query } from "@/server/http";
import { Pagination } from "@/server/api";
import { listInvitations } from "@/server/intake/invitations";

export const GET = authed("intake.view", async ({ req, auth }) => {
  const p = query(req, Pagination);
  return { items: await listInvitations(auth.organisationId, { limit: p.pageSize, offset: (p.page - 1) * p.pageSize }) };
});
