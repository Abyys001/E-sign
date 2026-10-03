import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { IsoDate } from "@/server/accounting/core";
import { financeOverview } from "@/server/accounting/finance";

const Q = z.object({ from: IsoDate.optional(), to: IsoDate.optional() }).passthrough();

/** Global financial overview: totals per currency, optional converted totals, monthly series, profit by event, outstanding balances. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  return { ...(await financeOverview(auth.organisationId, mode, q)), mode };
});
