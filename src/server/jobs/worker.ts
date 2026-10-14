import { getBoss, QUEUES } from "./index";
import { deliverEmail } from "../messaging/email";
import { deliverSms } from "../messaging/sms";
import { deliverWebhook } from "../webhooks/deliver";
import { processSubmission } from "../intake/process";
import { auditExpiredInvitations, scanIntakeReminders, scanIntakeRetention, sweepIntake } from "../intake/tasks";
import { finalizeContract, scanExpiry, scanReminders, scanRetention, sweepOutbox } from "./tasks";
import { log } from "../logger";
import { accountingEnabled } from "../accounting/core";
import { executeRun, processStripeEvent, scanScheduledSyncs } from "../accounting/sync";
import { syncAllWise } from "../accounting/wise";
import { syncAllProfitShares } from "../accounting/profit-share";
import { syncAllPayouts } from "../accounting/stripe-payouts";

type J<T> = { id: string; data: T; retryCount?: number; retryLimit?: number };

/** Background worker process: `npm run worker`. Safe to run several copies; every handler is idempotent. */
async function main() {
  const boss = await getBoss();
  const wrap = <T,>(name: string, fn: (j: J<T>) => Promise<unknown>) => async (jobs: J<T>[]) => {
    for (const j of jobs) {
      const t0 = Date.now();
      try { await fn(j); log.info("job.done", { queue: name, jobId: j.id, ms: Date.now() - t0 }); }
      catch (e) { log.error("job.failed", { queue: name, jobId: j.id, retryCount: j.retryCount, err: e }); throw e; }
    }
  };
  await boss.work(QUEUES.email, { localConcurrency: 4 }, wrap<{ messageId: string }>("email", (j) => deliverEmail(j.data.messageId, j.retryCount ?? 0, j.retryLimit ?? 0)));
  await boss.work(QUEUES.sms, { localConcurrency: 2 }, wrap<{ messageId: string }>("sms", (j) => deliverSms(j.data.messageId, j.retryCount ?? 0, j.retryLimit ?? 0)));
  await boss.work(QUEUES.webhook, { localConcurrency: 4 }, wrap<{ deliveryId: string }>("webhook", (j) => deliverWebhook(j.data.deliveryId)));
  await boss.work(QUEUES.finalize, { localConcurrency: 2 }, wrap<{ contractId: string }>("finalize", (j) => finalizeContract(j.data.contractId)));
  await boss.work(QUEUES.intakeProcess, { localConcurrency: 2 }, wrap<{ submissionId: string; submissionRev: number }>("intake", (j) => processSubmission(j.data.submissionId, j.data.submissionRev)));
  await boss.work(QUEUES.intakeReminders, wrap("intake-reminders", async () => { await scanIntakeReminders(); await auditExpiredInvitations(); }));
  await boss.work(QUEUES.expireScan, wrap("expire", () => scanExpiry()));
  await boss.work(QUEUES.remindersScan, wrap("reminders", () => scanReminders()));
  await boss.work(QUEUES.outboxSweep, wrap("sweep", async () => { await sweepOutbox(); await sweepIntake(); }));
  await boss.work(QUEUES.retentionScan, wrap("retention", async () => { await scanRetention(); await scanIntakeRetention(); }));
  await boss.work(QUEUES.acctSync, { localConcurrency: 1 }, wrap<{ runId: string }>("accounting-sync", (j) => executeRun(j.data.runId)));
  await boss.work(QUEUES.acctStripeEvent, { localConcurrency: 2 }, wrap<{ eventRowId: string }>("accounting-stripe-event", (j) => processStripeEvent(j.data.eventRowId)));
  await boss.work(QUEUES.acctScan, wrap("accounting-scan", async () => { await scanScheduledSyncs(); await syncAllWise(); await syncAllProfitShares(); await syncAllPayouts(); }));
  await boss.work(QUEUES.dead, wrap<Record<string, unknown>>("dead-letter", async (j) => { log.error("job.dead_letter", { jobId: j.id, data: j.data }); }));
  await boss.schedule(QUEUES.expireScan, "*/5 * * * *");
  await boss.schedule(QUEUES.remindersScan, "*/5 * * * *");
  await boss.schedule(QUEUES.intakeReminders, "*/5 * * * *");
  await boss.schedule(QUEUES.outboxSweep, "* * * * *");
  await boss.schedule(QUEUES.retentionScan, "17 3 * * *");
  if (accountingEnabled()) await boss.schedule(QUEUES.acctScan, "*/30 * * * *");
  else await boss.unschedule(QUEUES.acctScan).catch(() => {});
  log.info("worker.started", {});
  const stop = async () => { await boss.stop({ graceful: true, timeout: 20_000 }); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
