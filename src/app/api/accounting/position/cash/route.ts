import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Currency } from "@/server/accounting/core";
import { financialPosition } from "@/server/accounting/position";

const Q = z.object({ currency: Currency }).passthrough();

/** One currency of the financial position, for "what happens to cash if I pay this" previews. Read-only. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const { currency } = query(req, Q);
  const p = await financialPosition(auth.organisationId, mode, {});
  const pos = p.positions.find((x) => x.currency === currency);
  return { asOf: p.asOf, currency, cash: pos?.cash ?? 0, cashAvailableNow: pos?.cashAvailableNow ?? 0, liabilities: pos?.liabilities ?? 0, liabilitiesDueNow: pos?.liabilitiesDueNow ?? 0, remaining: pos?.remaining ?? 0 };
});
