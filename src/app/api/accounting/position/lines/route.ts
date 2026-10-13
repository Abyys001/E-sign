import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Currency, IsoDate } from "@/server/accounting/core";
import { accountLines } from "@/server/accounting/position";

const Q = z.object({
  codes: z.string().regex(/^\d{4}(,\d{4}){0,9}$/, "Account codes, comma separated"), currency: Currency,
  from: IsoDate.optional(), to: IsoDate.optional(), organiserId: z.string().uuid().optional(),
}).passthrough();

/** Ledger lines behind one figure on the financial position page (drill-down). */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  return { items: await accountLines(auth.organisationId, mode, q.codes.split(","), q.currency, { from: q.from, to: q.to }, { organiserId: q.organiserId }) };
});
