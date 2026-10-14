import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { listLimitRequests } from "@/server/treasury/admin";
export const GET = acct("treasury.admin", async ({ req, auth }) => {
  const q = query(req, z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional() }).passthrough());
  return { items: await listLimitRequests(auth.organisationId, q.status) };
});
