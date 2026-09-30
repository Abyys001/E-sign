import { PgBoss, fromDrizzle, type SendOptions } from "pg-boss";
import { sql } from "drizzle-orm";
import type { Tx } from "@/db";

export const QUEUES = {
  email: "email.send", sms: "sms.send", webhook: "webhook.deliver", finalize: "contract.finalize",
  remindersScan: "reminders.scan", expireScan: "contracts.expire", outboxSweep: "outbox.sweep",
  retentionScan: "retention.scan", intakeProcess: "intake.process", intakeReminders: "intake.reminders", maintenance: "maintenance", dead: "dead-letter",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const RETRY: Record<string, SendOptions & { deadLetter?: string }> = {
  [QUEUES.email]: { retryLimit: 6, retryDelay: 30, retryBackoff: true },
  [QUEUES.sms]: { retryLimit: 4, retryDelay: 30, retryBackoff: true },
  [QUEUES.webhook]: { retryLimit: 0 }, // webhook retries are scheduled by us so attempts/backoff are visible in webhook_deliveries
  [QUEUES.finalize]: { retryLimit: 8, retryDelay: 15, retryBackoff: true },
  [QUEUES.intakeProcess]: { retryLimit: 5, retryDelay: 15, retryBackoff: true },
};

const g = globalThis as unknown as { __boss?: Promise<PgBoss> };

/** One shared pg-boss instance per process. Web processes only send; the worker process also registers handlers. */
export function getBoss(): Promise<PgBoss> {
  return (g.__boss ??= (async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, application_name: "bilit-esign" });
    boss.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "pgboss.error", err: String(e) })));
    await boss.start();
    await boss.createQueue(QUEUES.dead);
    for (const q of Object.values(QUEUES)) {
      if (q === QUEUES.dead) continue;
      await boss.createQueue(q, { ...(RETRY[q] ?? { retryLimit: 3, retryDelay: 60, retryBackoff: true }), deadLetter: QUEUES.dead });
    }
    return boss;
  })());
}

/**
 * Enqueue atomically with the caller's transaction (outbox guarantee: no job without the state change, no state change without the job).
 * `singletonKey` makes duplicates collapse, which is one layer of idempotency; handlers still check DB state.
 */
export async function enqueue(tx: Tx | null, queue: QueueName, data: Record<string, unknown>, opts: SendOptions = {}) {
  const boss = await getBoss();
  const options: SendOptions = { ...opts, ...(tx ? { db: fromDrizzle(tx, sql) } : {}) };
  return boss.send(queue, data, options);
}

export async function stopBoss() {
  if (!g.__boss) return;
  const b = await g.__boss;
  g.__boss = undefined;
  await b.stop({ graceful: false, close: true });
}
