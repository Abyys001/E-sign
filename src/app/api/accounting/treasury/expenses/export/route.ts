import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { query } from "@/server/http";
import { csvStream, type CsvColumn } from "@/server/accounting/reports";
import { expenseExport, type ExpenseExportRow } from "@/server/treasury/admin";

const Q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const COLS: CsvColumn<ExpenseExportRow>[] = [
  { header: "Date (UTC)", value: (r) => r.date }, { header: "Transaction", value: (r) => r.transactionId }, { header: "Type", value: (r) => r.type },
  { header: "Amount", value: (r) => r.amount, money: (r) => r.currency }, { header: "Currency", value: (r) => r.currency.toUpperCase() },
  { header: "Merchant", value: (r) => r.merchant }, { header: "Category", value: (r) => r.category }, { header: "City", value: (r) => r.city }, { header: "Country", value: (r) => r.country },
  { header: "Card", value: (r) => (r.cardLast4 ? `•••• ${r.cardLast4}` : "") }, { header: "Card name", value: (r) => r.cardNickname }, { header: "Cardholder", value: (r) => r.cardholder },
  { header: "Staff", value: (r) => r.staff }, { header: "Note", value: (r) => r.note }, { header: "Receipt", value: (r) => r.receipt },
];
/** Authorised expense report: posted card transactions for the period with staff, notes and receipt names. */
export const GET = acct("treasury.admin", async ({ req, auth, ctx, mode }) => {
  const q = query(req, Q);
  const rows = await expenseExport({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, mode, new Date(`${q.from}T00:00:00Z`), new Date(`${q.to}T23:59:59Z`));
  return csvResponse(csvStream(COLS, async () => ({ rows, more: false })), `card-expenses-${mode}-${q.from}-to-${q.to}`);
});
