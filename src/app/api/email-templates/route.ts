import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { authed } from "@/server/http";
import { ALL_VARS, DEFAULT_TEMPLATES, EMAIL_TEMPLATE_KEYS } from "@/server/messaging/templates";

export const GET = authed("settings.manage", async ({ auth }) => {
  const custom = await db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.organisationId, auth.organisationId));
  return { variables: ALL_VARS, items: EMAIL_TEMPLATE_KEYS.flatMap((key) => (["en", "fa"] as const).map((locale) => { const c = custom.find((x) => x.key === key && x.locale === locale); return { key, locale, customized: !!c, enabled: c?.enabled ?? true, version: c?.version ?? 0, subject: c?.subject ?? DEFAULT_TEMPLATES[locale][key].subject }; })) };
});
