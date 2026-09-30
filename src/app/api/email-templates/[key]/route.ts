import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { authed, body, query } from "@/server/http";
import { brandFor, previewVars, renderEmail } from "@/server/messaging/email";
import { sanitizeBody } from "@/server/messaging/render";
import { DEFAULT_TEMPLATES, EMAIL_TEMPLATE_KEYS, allowedVarsFor, validateTemplate, type EmailTemplateKey } from "@/server/messaging/templates";

const Locale = z.enum(["en", "fa"]).default("en");
const keyOf = (k: string): EmailTemplateKey => { if (!(EMAIL_TEMPLATE_KEYS as readonly string[]).includes(k)) throw new AppError("not_found", "Template not found"); return k as EmailTemplateKey; };

export const GET = authed<{ key: string }>("settings.manage", async ({ req, auth, params }) => {
  const key = keyOf(params.key);
  const { locale } = query(req, z.object({ locale: Locale }));
  const [c] = await db.select().from(schema.emailTemplates).where(and(eq(schema.emailTemplates.organisationId, auth.organisationId), eq(schema.emailTemplates.key, key), eq(schema.emailTemplates.locale, locale)));
  const def = DEFAULT_TEMPLATES[locale][key];
  return { key, locale, customized: !!c, enabled: c?.enabled ?? true, subject: c?.subject ?? def.subject, body: c?.bodyHtml ?? def.body, defaults: def, allowedVariables: allowedVarsFor(key), version: c?.version ?? 0 };
});

/** Save = new version of the override. Invalid variables and scripts are rejected here, so they cannot silently break emails later. */
export const PUT = authed<{ key: string }>("settings.manage", async ({ req, auth, ctx, params }) => {
  const key = keyOf(params.key);
  const b = await body(req, z.object({ locale: Locale, subject: z.string().trim().min(1).max(200), body: z.string().min(1).max(20000), enabled: z.boolean().default(true) }));
  const problems = validateTemplate(key, b.subject, b.body);
  if (problems.length) throw new AppError("validation_failed", problems.join(". "), problems.map((m) => ({ path: "body", message: m })));
  const clean = sanitizeBody(b.body);
  await db.transaction(async (tx) => {
    await tx.insert(schema.emailTemplates).values({ organisationId: auth.organisationId, key, locale: b.locale, subject: b.subject, bodyHtml: clean, enabled: b.enabled })
      .onConflictDoUpdate({ target: [schema.emailTemplates.organisationId, schema.emailTemplates.key, schema.emailTemplates.locale], set: { subject: b.subject, bodyHtml: clean, enabled: b.enabled, version: sql`${schema.emailTemplates.version} + 1`, updatedAt: new Date() } });
    await audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "email_template.updated", ctx, metadata: { key, locale: b.locale } });
  });
  return { ok: true };
});

export const DELETE = authed<{ key: string }>("settings.manage", async ({ req, auth, ctx, params }) => {
  const key = keyOf(params.key);
  const { locale } = query(req, z.object({ locale: Locale }));
  await db.transaction(async (tx) => {
    await tx.delete(schema.emailTemplates).where(and(eq(schema.emailTemplates.organisationId, auth.organisationId), eq(schema.emailTemplates.key, key), eq(schema.emailTemplates.locale, locale)));
    await audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "email_template.reset", ctx, metadata: { key, locale } });
  });
  return { ok: true };
});

/** POST = preview with sample variables, never sends anything. */
export const POST = authed<{ key: string }>("settings.manage", async ({ req, auth, params }) => {
  const key = keyOf(params.key);
  const b = await body(req, z.object({ locale: Locale, subject: z.string().max(200), body: z.string().max(20000) }));
  const problems = validateTemplate(key, b.subject, b.body);
  const brand = await brandFor(auth.organisationId);
  if (problems.length) return { problems, html: null, subject: null };
  const out = renderEmail({ subject: b.subject, body: sanitizeBody(b.body) }, previewVars(brand), brand, b.locale);
  return { problems: [], subject: out.subject, html: out.html.replace("cid:bilit-logo", "/brand/bilit-esign-logo-email.png") };
});
