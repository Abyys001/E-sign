import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { editExpense, ExpenseEdit } from "@/server/accounting/expenses";

/** Edit an expense. Ledger-relevant changes reverse the old entry and post a new one. */
export const PATCH = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) =>
  editExpense({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Expense"), await body(req, ExpenseEdit)));
