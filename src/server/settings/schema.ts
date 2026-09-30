import { z } from "zod";

const locale = z.enum(["en", "fa"]);
export const AUTH_LEVELS = ["LINK", "EMAIL_OTP", "SMS_OTP", "PASSCODE", "ACCOUNT"] as const;

export const SettingsSchema = z.object({
  general: z.object({
    timezone: z.string().default("UTC"),
    locale: locale.default("en"),
    currency: z.string().regex(/^[A-Z]{3}$/).default("GBP"),
    referencePrefix: z.string().regex(/^[A-Z0-9]{2,8}$/).default("CTR"),
    referenceScope: z.enum(["organisation", "global"]).default("organisation"),
  }).prefault({}),
  security: z.object({
    requireTotpForAdmins: z.boolean().default(false),
    elevationMinutes: z.number().int().min(1).max(60).default(10),
    sessionHours: z.number().int().min(1).max(720).default(24 * 7),
    allowedUploadMime: z.array(z.string()).default(["application/pdf"]),
    maxUploadMb: z.number().min(1).max(100).default(25),
  }).prefault({}),
  email: z.object({
    useOrgSmtp: z.boolean().default(false),
    host: z.string().default(""),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().default(""),
    passwordEnc: z.string().default(""), // AES-GCM ciphertext; never returned by the API
    fromName: z.string().default(""),
    fromAddress: z.string().default(""),
    replyTo: z.string().default(""),
    headers: z.record(z.string(), z.string()).default({}),
  }).prefault({}),
  sms: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(["none", "twilio"]).default("none"),
    accountId: z.string().default(""),
    authTokenEnc: z.string().default(""),
    fromNumber: z.string().default(""),
  }).prefault({}),
  signing: z.object({
    defaultExpiryDays: z.number().int().min(1).max(365).default(30),
    defaultAuthLevel: z.enum(AUTH_LEVELS).default("LINK"),
    defaultSigningOrder: z.enum(["SEQUENTIAL", "PARALLEL"]).default("SEQUENTIAL"),
    allowTyped: z.boolean().default(true),
    allowDrawn: z.boolean().default(true),
    allowUploaded: z.boolean().default(true),
    tokenTtlHours: z.number().int().min(1).max(24 * 90).default(24 * 30),
    consentText: z.record(locale, z.string()).default({
      en: "I agree to use electronic records and electronic signatures, and I intend my signature to have the same effect as a handwritten signature.",
      fa: "من با استفاده از اسناد و امضای الکترونیکی موافقم و قصد دارم امضای من همان اعتبار امضای دستی را داشته باشد.",
    }),
    consentRequired: z.boolean().default(true),
    includeIpOnCertificate: z.boolean().default(true),
    publicVerification: z.boolean().default(true),
    otpTtlMinutes: z.number().int().min(1).max(60).default(10),
    otpMaxAttempts: z.number().int().min(1).max(10).default(5),
  }).prefault({}),
  notifications: z.object({
    notifySenderOnView: z.boolean().default(true),
    notifySenderOnSign: z.boolean().default(true),
    emailCompletedToSigners: z.boolean().default(true),
    attachFinalPdfToEmail: z.boolean().default(false),
  }).prefault({}),
  reminders: z.object({
    enabled: z.boolean().default(true),
    afterHours: z.array(z.number().int().min(1).max(24 * 60)).default([24, 48, 72]),
    beforeExpiryDays: z.array(z.number().int().min(1).max(90)).default([3, 1]),
  }).prefault({}),
  webhooks: z.object({ timeoutSeconds: z.number().int().min(1).max(30).default(10), maxAttempts: z.number().int().min(1).max(20).default(8) }).prefault({}),
  retention: z.object({
    documents: z.enum(["never", "1y", "3y", "5y", "7y", "custom"]).default("never"),
    documentsCustomDays: z.number().int().min(30).max(36500).default(2555),
    audit: z.enum(["never", "1y", "3y", "5y", "7y", "custom"]).default("never"),
    auditCustomDays: z.number().int().min(30).max(36500).default(2555),
    warnDays: z.number().int().min(1).max(365).default(30),
    autoDelete: z.boolean().default(false),
  }).prefault({}),
  // Intake access analytics. 0 = keep. IPs are anonymised (truncated) before rows are deleted.
  privacy: z.object({
    ipAnonymiseDays: z.number().int().min(0).max(3650).default(90),
    telemetryDays: z.number().int().min(0).max(3650).default(365),
  }).prefault({}),
  rateLimits: z.object({
    signingSubmitPerMinute: z.number().int().min(1).max(600).optional(),
    sendContractPerHour: z.number().int().min(1).max(10000).optional(),
    smsPerHour: z.number().int().min(1).max(10000).optional(),
    emailPerHour: z.number().int().min(1).max(100000).optional(),
  }).prefault({}),
});
export type OrgSettings = z.infer<typeof SettingsSchema>;

export const BrandingSchema = z.object({
  displayName: z.string().max(120).default(""),
  logoObjectId: z.string().uuid().nullable().default(null),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  supportEmail: z.string().email().or(z.literal("")).default(""),
  supportPhone: z.string().max(40).default(""),
  emailFooter: z.string().max(1000).default(""),
  signingPageTagline: z.string().max(200).default(""),
});
export type OrgBranding = z.infer<typeof BrandingSchema>;

/** Secret-bearing keys that must never leave the server. */
export function redactSettings(s: OrgSettings): Omit<OrgSettings, never> {
  return {
    ...s,
    email: { ...s.email, passwordEnc: s.email.passwordEnc ? "__set__" : "" },
    sms: { ...s.sms, authTokenEnc: s.sms.authTokenEnc ? "__set__" : "" },
  };
}
