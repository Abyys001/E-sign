import { sql } from "drizzle-orm";
import { db } from "@/db";
import { AppError } from "./errors";
import { log } from "./logger";

/** Named limit profiles. `windowSec` is a fixed window; keys combine the profile with an actor (ip, email, token, user). */
export const LIMITS = {
  login: { limit: 8, windowSec: 900 },
  loginEmail: { limit: 5, windowSec: 900 },
  signingOpen: { limit: 60, windowSec: 60 },
  signingSubmit: { limit: 20, windowSec: 60 },
  signingTokenGuess: { limit: 30, windowSec: 600 },
  otpRequest: { limit: 5, windowSec: 900 },
  otpVerifyIp: { limit: 20, windowSec: 900 },
  emailVerify: { limit: 5, windowSec: 900 },
  api: { limit: 300, windowSec: 60 },
  download: { limit: 60, windowSec: 60 },
  webhookTest: { limit: 10, windowSec: 60 },
  sendContract: { limit: 100, windowSec: 3600 },
  smsSend: { limit: 200, windowSec: 3600 },
  emailSend: { limit: 1000, windowSec: 3600 },
  intakeTokenGuess: { limit: 20, windowSec: 600 }, // invalid/expired/revoked tokens, per IP
  intakeOpen: { limit: 60, windowSec: 60 },
  intakeSession: { limit: 30, windowSec: 600 }, // new sessions per invitation
  intakeSave: { limit: 120, windowSec: 600 },
  intakeSubmit: { limit: 10, windowSec: 600 },
  intakeOtp: { limit: 5, windowSec: 900 },
  intakeUpload: { limit: 30, windowSec: 600 },
  intakeBeat: { limit: 120, windowSec: 60 },
  stripeWebhookBad: { limit: 30, windowSec: 60 }, // unsigned / badly signed Stripe webhook attempts, per IP
  accountingExport: { limit: 30, windowSec: 600 },
  accountingSync: { limit: 20, windowSec: 600 },
  aiChat: { limit: 40, windowSec: 600 }, // questions to the AI finance assistant, per user
  aiVoice: { limit: 60, windowSec: 600 }, // speech-to-text / text-to-speech for the AI Accountant, per user
  treasuryLoginIp: { limit: 20, windowSec: 900 }, // staff portal login attempts, per IP
  treasuryLoginEmail: { limit: 6, windowSec: 900 }, // staff portal login attempts, per email
  treasuryStaff: { limit: 240, windowSec: 60 }, // authenticated staff portal requests
} as const;
export type LimitName = keyof typeof LIMITS;

/** Atomic fixed-window counter. Throws 429 when exceeded. Safe under concurrent requests (single upsert statement). */
export async function rateLimit(name: LimitName, actor: string, override?: { limit?: number; windowSec?: number }) {
  const { limit, windowSec } = { ...LIMITS[name], ...override };
  const bucket = `${name}:${actor}`;
  const res = await db.execute<{ count: number; window_start: Date }>(sql`
    insert into rate_limits (bucket, count, window_start) values (${bucket}, 1, now())
    on conflict (bucket) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then now() else rate_limits.window_start end
    returning count, window_start`);
  const row = res.rows[0]!;
  if (row.count > limit) {
    const retry = Math.max(1, Math.ceil(windowSec - (Date.now() - new Date(row.window_start).getTime()) / 1000));
    log.security("rate_limited", { name, actor: name.startsWith("login") ? "[hashed]" : actor });
    throw new AppError("rate_limited", "Too many attempts. Please wait a moment and try again.", { retryAfterSeconds: retry }, { "Retry-After": String(retry) });
  }
}

export async function purgeRateLimits() {
  await db.execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`);
}
