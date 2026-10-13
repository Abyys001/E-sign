import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { IsoDate } from "@/server/accounting/core";
import { financialPosition } from "@/server/accounting/position";

const Q = z.object({ from: IsoDate.optional(), to: IsoDate.optional() }).passthrough();

/** Financial position: verified cash, liabilities, organiser settlements, profit, cash flow and alerts (per currency). */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  return financialPosition(auth.organisationId, mode, { from: q.from, to: q.to });
});
