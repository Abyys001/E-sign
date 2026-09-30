import { z } from "zod";
import { authed, body } from "@/server/http";
import { tx } from "@/server/api";
import { getOrgBranding, updateOrgBranding } from "@/server/settings";
import { BrandingSchema } from "@/server/settings/schema";

export const GET = authed("settings.manage", async ({ auth }) => getOrgBranding(auth.organisationId));
export const PATCH = authed("settings.manage", async ({ req, auth, ctx }) => {
  const patch = await body(req, BrandingSchema.omit({ logoObjectId: true }).partial().extend({ primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() }));
  await tx((t) => updateOrgBranding(t, auth.organisationId, auth.user.id, patch, ctx));
  return getOrgBranding(auth.organisationId);
});
