import { z } from "zod";

const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hex chars (openssl rand -hex 32)");

const schema = z.object({
  APP_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: hex32,
  SIGNING_TOKEN_SECRET: hex32,
  OTP_SECRET: hex32,
  WEBHOOK_SECRET: hex32,
  SETTINGS_ENCRYPTION_KEY: hex32,
  CONTRACT_STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  CONTRACT_STORAGE_LOCAL_DIR: z.string().default("./storage-data"),
  CONTRACT_STORAGE_BUCKET: z.string().optional(),
  CONTRACT_STORAGE_REGION: z.string().optional(),
  CONTRACT_STORAGE_ENDPOINT: z.string().optional(),
  CONTRACT_STORAGE_ACCESS_KEY: z.string().optional(),
  CONTRACT_STORAGE_SECRET_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_FROM: z.string().default("Bilit.event E-Sign <no-reply@localhost>"),
  SMTP_REPLY_TO: z.string().optional(),
  /** Reverse proxies in front of the app that append to X-Forwarded-For. 0 = ignore forwarding headers entirely. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  SMS_PROVIDER: z.enum(["none", "twilio"]).default("none"),
  SMS_ACCOUNT_ID: z.string().optional(),
  SMS_AUTH_TOKEN: z.string().optional(),
  SMS_FROM_NUMBER: z.string().optional(),
  WEBHOOK_ALLOW_PRIVATE_TARGETS: z.enum(["true", "false"]).default("false"),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
  MAX_PDF_PAGES: z.coerce.number().default(200),
  /** Finance module (Stripe accounting). Off unless explicitly enabled for a deployment. */
  ACCOUNTING_ENABLED: z.enum(["true", "false"]).default("false"),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  return (cached = parsed.data);
}
