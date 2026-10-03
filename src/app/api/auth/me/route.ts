import { authed } from "@/server/http";
import { listUserOrgs } from "@/server/orgs";
import { PERMISSIONS, can } from "@/server/rbac";
import { getOrgBranding, getOrgSettings } from "@/server/settings";
import { redactSettings } from "@/server/settings/schema";
import { accountingEnabled } from "@/server/accounting/core";

export const GET = authed(null, async ({ auth }) => {
  const [orgs, branding, settings] = await Promise.all([listUserOrgs(auth.user.id, auth.user.isSuperAdmin), getOrgBranding(auth.organisationId), getOrgSettings(auth.organisationId)]);
  return {
    user: auth.user, csrfToken: auth.csrfToken, organisations: orgs, activeOrganisationId: auth.organisationId, branding,
    features: { accounting: accountingEnabled() },
    roleKey: auth.membership.roleKey, permissions: PERMISSIONS.filter((p) => can(auth.membership, p)), elevated: auth.elevated,
    settings: { general: redactSettings(settings).general, signing: { allowTyped: settings.signing.allowTyped, allowDrawn: settings.signing.allowDrawn, allowUploaded: settings.signing.allowUploaded, defaultExpiryDays: settings.signing.defaultExpiryDays, defaultAuthLevel: settings.signing.defaultAuthLevel, defaultSigningOrder: settings.signing.defaultSigningOrder }, sms: { enabled: settings.sms.enabled && settings.sms.provider !== "none" } },
  };
});
