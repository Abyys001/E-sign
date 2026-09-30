import { z } from "zod";
import { authed, body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { smsProviderFor, SmsNotConfiguredError } from "@/server/messaging/sms";
import { AppError } from "@/server/errors";

/** Sends a REAL text message through the configured provider; if none is configured it says so instead of pretending. */
export const POST = authed("settings.manage", async ({ req, auth }) => {
  requireElevation(auth);
  await rateLimit("webhookTest", `sms:${auth.user.id}`);
  const { to } = await body(req, z.object({ to: z.string().regex(/^\+[1-9]\d{6,14}$/, "Use international format, e.g. +447700900123") }));
  try {
    const p = await smsProviderFor(auth.organisationId);
    const r = await p.send({ to, body: "Bilit.event E-Sign: this is a test message from your SMS settings." });
    return { ok: true, providerMessageId: r.providerMessageId };
  } catch (e) {
    if (e instanceof SmsNotConfiguredError) throw new AppError("config_missing", "No SMS provider is configured. Set one under Settings → SMS.");
    throw new AppError("bad_request", `The provider refused the message: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
  }
});
