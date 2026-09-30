import nodemailer from "nodemailer";
import { authed } from "@/server/http";
import { requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { smtpConfigFor } from "@/server/messaging/email";
import { AppError } from "@/server/errors";

/** Connects and authenticates against the configured server without sending anything. */
export const POST = authed("settings.manage", async ({ auth }) => {
  requireElevation(auth);
  await rateLimit("webhookTest", `mailverify:${auth.user.id}`);
  const cfg = await smtpConfigFor(auth.organisationId);
  if (!cfg) throw new AppError("config_missing", "No SMTP server is configured. Set one under Settings → Email.");
  const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined, connectionTimeout: 10_000, socketTimeout: 15_000, tls: { minVersion: "TLSv1.2" } });
  try {
    await t.verify();
    return { ok: true, host: cfg.host, port: cfg.port, secure: cfg.secure, authenticated: !!cfg.user };
  } catch (e) {
    throw new AppError("bad_request", `Could not connect: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
  } finally { t.close(); }
});
