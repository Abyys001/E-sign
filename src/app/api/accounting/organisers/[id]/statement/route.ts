import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination, requireElevation, uuid } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { Currency, IsoDate } from "@/server/accounting/core";
import { csvStream, organiserStatement } from "@/server/accounting/reports";

const Q = Pagination.extend({ currency: Currency, from: IsoDate.optional(), to: IsoDate.optional(), format: z.enum(["csv"]).optional() }).passthrough();
type R = Awaited<ReturnType<typeof organiserStatement>>["rows"][number];

export const GET = acct<{ id: string }>("accounting.view", async ({ req, auth, params, mode }) => {
  const id = uuid(params.id, "Organiser");
  const q = query(req, Q);
  const range = { from: q.from, to: q.to };
  if (q.format) {
    requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
    const m = (_: R) => q.currency;
    return csvResponse(csvStream<R>([
      { header: "date", value: (r) => r.date }, { header: "event", value: (r) => r.eventName }, { header: "event_code", value: (r) => r.eventCode }, { header: "entry_type", value: (r) => r.entryType },
      { header: "order", value: (r) => r.order }, { header: "customer", value: (r) => r.customer }, { header: "description", value: (r) => r.description }, { header: "reference", value: (r) => r.reference },
      { header: "sales", value: (r) => r.sales, money: m }, { header: "refunds", value: (r) => r.refunds, money: m }, { header: "fees", value: (r) => r.fees, money: m },
      { header: "commission", value: (r) => r.commission, money: m }, { header: "payments", value: (r) => r.payments, money: m }, { header: "balance_change", value: (r) => r.change, money: m },
      { header: "balance", value: (r) => r.balance, money: m }, { header: "currency", value: () => q.currency.toUpperCase() },
    ], async (page) => { const r = await organiserStatement(auth.organisationId, mode, id, q.currency, range, { limit: 2000, offset: page * 2000 }); return { rows: r.rows, more: r.rows.length === 2000 }; }), `organiser-statement-${q.currency}-${mode}`);
  }
  return { ...(await organiserStatement(auth.organisationId, mode, id, q.currency, range, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize };
});
