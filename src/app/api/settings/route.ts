import { z } from "zod";
import { authed, body } from "@/server/http";
import { tx, requireElevation } from "@/server/api";
import { getOrgSettings, updateOrgSettings } from "@/server/settings";
import { SettingsSchema, redactSettings } from "@/server/settings/schema";
import { AppError } from "@/server/errors";

const SENSITIVE = new Set(["security", "email", "sms", "retention", "webhooks", "rateLimits", "privacy"]);
const Patch = z.record(z.string(), z.record(z.string(), z.unknown()));

export const GET = authed("settings.manage", async ({ auth }) => redactSettings(await getOrgSettings(auth.organisationId)));

export const PATCH = authed("settings.manage", async ({ req, auth, ctx }) => {
  const raw = await body(req, Patch);
  // Ciphertext columns are written only by the server (from `password` / `authToken`); a client must not be able to set them directly.
  delete raw.email?.passwordEnc; delete raw.sms?.authTokenEnc;
  const unknown = Object.keys(raw).filter((k) => !(k in SettingsSchema.shape));
  if (unknown.length) throw new AppError("validation_failed", `Unknown settings section: ${unknown.join(", ")}`);
  if (Object.keys(raw).some((k) => SENSITIVE.has(k))) requireElevation(auth);
  const next = await tx((t) => updateOrgSettings(t, auth.organisationId, auth.user.id, raw as never, ctx));
  return redactSettings(next);
});
