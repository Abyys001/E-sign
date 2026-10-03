import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { ensureLedgerSetup, IsoDate } from "@/server/accounting/core";
import { trialBalance } from "@/server/accounting/reports";

const Q = z.object({ to: IsoDate.optional(), mode: z.string().optional() });

/** Chart of accounts plus the trial balance (per currency) as of `to`. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  await ensureLedgerSetup(db, auth.organisationId);
  const accounts = await db.select().from(schema.acctAccounts).where(eq(schema.acctAccounts.organisationId, auth.organisationId)).orderBy(asc(schema.acctAccounts.code));
  return { accounts, trialBalance: await trialBalance(auth.organisationId, mode, q.to) };
});
