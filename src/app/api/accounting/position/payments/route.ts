import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Currency } from "@/server/accounting/core";
import { settlementPayments } from "@/server/accounting/position";

const Q = z.object({ organiserId: z.string().uuid(), currency: Currency }).passthrough();

/** Every payment (voided ones included, for the audit trail) behind an organiser's settlement in one currency. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  return { items: await settlementPayments(auth.organisationId, mode, q.organiserId, q.currency) };
});
