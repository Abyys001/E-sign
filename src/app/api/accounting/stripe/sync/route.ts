import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { IsoDate, ModeSchema } from "@/server/accounting/core";
import { createSyncRun, latestRuns, SYNC_KINDS } from "@/server/accounting/sync";
import { listSyncErrors } from "@/server/accounting/queries";

export const GET = acct("accounting.view", async ({ auth, mode }) => ({ runs: await latestRuns(auth.organisationId, mode, 30), errors: await listSyncErrors(auth.organisationId, mode) }));

const Input = z.object({ mode: ModeSchema, kind: z.enum(SYNC_KINDS), from: IsoDate.optional(), to: IsoDate.optional() })
  .refine((b) => b.kind !== "RANGE" || (b.from && b.to), { message: "A date range needs both dates", path: ["from"] });

/** Queue a background synchronisation; progress is polled via GET. Idempotent by design — re-running never duplicates. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => {
  await rateLimit("accountingSync", auth.user.id);
  const b = await body(req, Input);
  return createSyncRun({ orgId: auth.organisationId, mode: b.mode, kind: b.kind, from: b.from ? new Date(`${b.from}T00:00:00Z`) : null, to: b.to ? new Date(`${b.to}T23:59:59Z`) : null, userId: auth.user.id, ctx });
});
