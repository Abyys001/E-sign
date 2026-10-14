import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { IsoDate } from "@/server/accounting/core";
import { dashboardSeries } from "@/server/accounting/command-centre";

const Q = z.object({ from: IsoDate.optional(), to: IsoDate.optional(), grain: z.enum(["day", "week", "month", "year"]).default("month") }).passthrough();

/** Sales, refunds, Stripe fees and net collected per day/week/month/year (ledger, per currency) for the dashboard chart. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  return { grain: q.grain, items: await dashboardSeries(auth.organisationId, mode, { from: q.from, to: q.to }, q.grain) };
});
