import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { isLive } from "@/server/accounting/core";
import { createExpense, ExpenseInput, listExpenses } from "@/server/accounting/expenses";

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, z.object({ eventId: z.string().uuid() }).passthrough());
  return { items: await listExpenses(auth.organisationId, isLive(mode), q.eventId), mode };
});

/** Record an event expense; posts it to the ledger (Bilit cost, or a deduction from the organiser). */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => createExpense({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, ExpenseInput)));
