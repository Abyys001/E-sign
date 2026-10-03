import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination } from "@/server/api";
import { isLive } from "@/server/accounting/core";
import { listTransactions, TxFilter } from "@/server/accounting/queries";

/** Unreconciled Stripe transactions (or any status) plus the latest reconciliation result for this mode. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, TxFilter.and(Pagination).and(z.object({ mode: z.string().optional() })));
  const f = q.status ? q : { ...q, unreconciled: true };
  const [list, [last]] = await Promise.all([
    listTransactions(auth.organisationId, mode, f, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
    db.select().from(schema.acctSyncRuns).where(and(eq(schema.acctSyncRuns.organisationId, auth.organisationId), eq(schema.acctSyncRuns.livemode, isLive(mode)), eq(schema.acctSyncRuns.status, "SUCCEEDED"))).orderBy(desc(schema.acctSyncRuns.finishedAt)).limit(1),
  ]);
  const summary = last ? ((last.summary as { reconciliation?: unknown }).reconciliation ?? (last.kind === "RECONCILE" ? last.summary : null)) : null;
  return { ...list, page: q.page, pageSize: q.pageSize, mode, lastReconciliation: summary, lastRunAt: last?.finishedAt ?? null };
});
