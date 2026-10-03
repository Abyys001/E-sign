import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { IsoDate } from "@/server/accounting/core";
import { dashboard } from "@/server/accounting/reports";

const Q = z.object({ from: IsoDate.optional(), to: IsoDate.optional(), mode: z.string().optional() });

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  return dashboard(auth.organisationId, mode, { from: q.from, to: q.to });
});
