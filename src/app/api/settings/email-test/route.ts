import nodemailer from "nodemailer";
import { authed } from "@/server/http";
import { requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { brandFor, previewVars, renderEmail, smtpConfigFor } from "@/server/messaging/email";
import { DEFAULT_TEMPLATES } from "@/server/messaging/templates";
import { AppError } from "@/server/errors";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Sends a REAL test email through the configured server and reports the server's actual answer. */
export const POST = authed("settings.manage", async ({ auth }) => {
  requireElevation(auth);
  await rateLimit("webhookTest", `mail:${auth.user.id}`);
  const cfg = await smtpConfigFor(auth.organisationId);
  if (!cfg) throw new AppError("config_missing", "No SMTP server is configured. Set one under Settings → Email.");
  const brand = await brandFor(auth.organisationId);
  const out = renderEmail(DEFAULT_TEMPLATES.en.signature_requested, previewVars(brand), brand, "en");
  const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined, connectionTimeout: 10_000, socketTimeout: 15_000 });
  try {
    const info = await t.sendMail({ from: cfg.from, to: auth.user.email, subject: `[Test] ${out.subject}`, html: out.html, text: out.text, replyTo: cfg.replyTo, attachments: [{ filename: "logo.png", content: await readFile(path.join(process.cwd(), "public/brand/bilit-esign-logo-email.png")), cid: "bilit-logo" }] });
    return { ok: true, to: auth.user.email, response: String(info.response).slice(0, 200) };
  } catch (e) {
    throw new AppError("bad_request", `The mail server refused the test: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
  }
});
