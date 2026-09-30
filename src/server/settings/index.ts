import { eq } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "../audit";
import { encrypt } from "../crypto";
import { BrandingSchema, SettingsSchema, type OrgBranding, type OrgSettings } from "./schema";

export async function getOrgSettings(orgId: string, tx: Pick<typeof db, "select"> = db): Promise<OrgSettings> {
  const [o] = await tx.select({ s: schema.organisations.settings }).from(schema.organisations).where(eq(schema.organisations.id, orgId));
  return SettingsSchema.parse(o?.s ?? {});
}

export async function getOrgBranding(orgId: string): Promise<OrgBranding & { orgName: string }> {
  const [o] = await db.select({ b: schema.organisations.branding, name: schema.organisations.name }).from(schema.organisations).where(eq(schema.organisations.id, orgId));
  const b = BrandingSchema.parse(o?.b ?? {});
  return { ...b, orgName: b.displayName || o?.name || "" };
}

type Deep = { [k: string]: unknown };
const isObj = (v: unknown): v is Deep => !!v && typeof v === "object" && !Array.isArray(v);
function merge(base: Deep, patch: Deep): Deep {
  const out: Deep = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k] as Deep, v) : v;
  return out;
}

/** Patch a settings section. Plain `password`/`authToken` inputs are encrypted here and never stored in clear. */
export async function updateOrgSettings(tx: Tx, orgId: string, userId: string, patch: Deep & { email?: Deep & { password?: string }; sms?: Deep & { authToken?: string } }, ctx: RequestContext) {
  const current = await getOrgSettings(orgId, tx);
  const p = structuredClone(patch) as Deep & { email?: Deep & { password?: string }; sms?: Deep & { authToken?: string } };
  if (p.email && "password" in p.email) {
    const pw = p.email.password; delete p.email.password;
    if (typeof pw === "string" && pw !== "" && pw !== "__set__") p.email.passwordEnc = encrypt(pw);
  }
  if (p.sms && "authToken" in p.sms) {
    const t = p.sms.authToken; delete p.sms.authToken;
    if (typeof t === "string" && t !== "" && t !== "__set__") p.sms.authTokenEnc = encrypt(t);
  }
  const next = SettingsSchema.parse(merge(current as unknown as Deep, p));
  await tx.update(schema.organisations).set({ settings: next, updatedAt: new Date() }).where(eq(schema.organisations.id, orgId));
  await audit(tx, { organisationId: orgId, userId, eventType: "settings.updated", ctx, metadata: { sections: Object.keys(patch) } });
  return next;
}

export async function updateOrgBranding(tx: Tx, orgId: string, userId: string, patch: Partial<OrgBranding>, ctx: RequestContext) {
  const [o] = await tx.select({ b: schema.organisations.branding }).from(schema.organisations).where(eq(schema.organisations.id, orgId));
  const next = BrandingSchema.parse({ ...BrandingSchema.parse(o?.b ?? {}), ...patch });
  await tx.update(schema.organisations).set({ branding: next, updatedAt: new Date() }).where(eq(schema.organisations.id, orgId));
  await audit(tx, { organisationId: orgId, userId, eventType: "branding.updated", ctx, metadata: { fields: Object.keys(patch) } });
  return next;
}
