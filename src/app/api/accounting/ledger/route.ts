import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { LedgerFilter, listEntries } from "@/server/accounting/queries";
import { csvStream } from "@/server/accounting/reports";

type Row = Awaited<ReturnType<typeof listEntries>>["items"][number];
type LineRow = Row["lines"][number] & { e: Row };

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, LedgerFilter.and(Pagination).and(z.object({ format: z.enum(["csv"]).optional(), mode: z.string().optional() })));
  if (q.format) {
    requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
    // One CSV row per ledger line (entry header repeated): the format accountants import.
    return csvResponse(csvStream<LineRow>([
      { header: "entry_date", value: (r) => r.e.entryDate }, { header: "entry_no", value: (r) => r.e.seq }, { header: "entry_type", value: (r) => r.e.entryType }, { header: "status", value: (r) => r.e.status },
      { header: "account_code", value: (r) => r.accountCode }, { header: "account_name", value: (r) => r.accountName },
      { header: "debit", value: (r) => r.debit, money: (r) => r.e.currency }, { header: "credit", value: (r) => r.credit, money: (r) => r.e.currency }, { header: "currency", value: (r) => r.e.currency.toUpperCase() },
      { header: "description", value: (r) => r.e.description }, { header: "reference", value: (r) => r.e.reference }, { header: "stripe_balance_transaction", value: (r) => r.e.stripeBalanceTransactionId },
      { header: "event_id", value: (r) => r.eventId }, { header: "organiser_id", value: (r) => r.organiserId }, { header: "reason", value: (r) => r.e.reason }, { header: "entry_id", value: (r) => r.e.id },
    ], async (page) => {
      const r = await listEntries(auth.organisationId, mode, q, { limit: 500, offset: page * 500 });
      return { rows: r.items.flatMap((e) => e.lines.map((l) => ({ ...l, e }))), more: r.items.length === 500 };
    }), `ledger-${mode}`);
  }
  const r = await listEntries(auth.organisationId, mode, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
  return { ...r, page: q.page, pageSize: q.pageSize, mode };
});
