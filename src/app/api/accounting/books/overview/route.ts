import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { IsoDate } from "@/server/accounting/core";
import { booksOverview } from "@/server/accounting/books";

/** Company profit & loss by account, unpaid supplier invoices, input VAT and payroll for a period (per currency). */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, z.object({ from: IsoDate.optional(), to: IsoDate.optional() }).passthrough());
  return { currencies: await booksOverview(auth.organisationId, mode, q), mode };
});
