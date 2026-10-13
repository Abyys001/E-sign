import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { RequestContext } from "../audit";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import { log } from "../logger";
import { acctAudit, getAcctSettings } from "./core";

/**
 * XE Currency Data API (xecdapi.xe.com) — mid-market exchange rates for the converted (indicative) totals on the
 * Financial Overview and in the AI Accountant. Reporting only: rates are never used for postings, which always stay in
 * the transaction's own currency. The API key is stored encrypted and never returned. Rates are cached for 15 minutes
 * (XE plans have monthly request quotas); the last good set is kept and used, marked as such, if XE is unreachable.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };
type Stored = { accountId?: string | null; apiKeyEnc?: string | null; keyHint?: string | null; lastRates?: Record<string, string>; lastTarget?: string | null; lastAt?: string | null; lastError?: string | null };
export type XeRates = { rates: Record<string, string>; at: string; source: string; stale?: boolean };

export const XeSettingsInput = z.object({
  accountId: z.string().trim().max(120).regex(/^[A-Za-z0-9._@-]*$/, "Use the account ID exactly as XE shows it").nullable(),
  apiKey: z.preprocess((v) => (typeof v === "string" ? v.replace(/[\s"'`​-‍﻿]/g, "") : v), z.string().min(8, "That does not look like a complete XE API key").max(200).optional().nullable()), // only sent when it changes; null removes it
});

const TTL_MS = 15 * 60_000;
const cache = new Map<string, { at: number; value: XeRates }>();

/** Rates as "1 SOURCE = rate TARGET" from XE's "1 TARGET = mid SOURCE" answer. Pure; unit-tested. */
export function invertRates(target: string, quotes: Array<{ quotecurrency: string; mid: number }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of quotes) {
    const c = q.quotecurrency.toLowerCase();
    if (c === target || !(q.mid > 0)) continue;
    out[c] = (1 / q.mid).toFixed(8);
  }
  return out;
}

// ---------- provider (injectable for tests) ----------
type Fetcher = (a: { accountId: string; apiKey: string; target: string; sources: string[] }) => Promise<{ timestamp: string; quotes: Array<{ quotecurrency: string; mid: number }> }>;
const g = globalThis as { __xeFetch?: Fetcher };
export const setXeFetch = (f: Fetcher | null) => { g.__xeFetch = f ?? undefined; cache.clear(); };

const xeFetch: Fetcher = async ({ accountId, apiKey, target, sources }) => {
  const url = `https://xecdapi.xe.com/v1/convert_from.json/?from=${target.toUpperCase()}&to=${sources.map((s) => s.toUpperCase()).join(",")}&amount=1`;
  let res: Response;
  try { res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { authorization: `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString("base64")}`, accept: "application/json" } }); }
  catch { throw new AppError("invalid_state", "Could not reach XE. Try again in a moment."); }
  const body = await res.json().catch(() => null) as { timestamp?: string; to?: Array<{ quotecurrency: string; mid: number }>; message?: string; code?: number } | null;
  if (res.status === 401 || res.status === 403) throw new AppError("validation_failed", `XE rejected the account ID / API key${body?.message ? `: ${body.message}` : ""}.`, [{ path: "apiKey", message: "Check the XE account ID and API key" }]);
  if (!res.ok || !Array.isArray(body?.to)) throw new AppError("invalid_state", `XE did not return rates (HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}).`);
  return { timestamp: body!.timestamp ?? new Date().toISOString(), quotes: body!.to! };
};

async function stored(orgId: string): Promise<Stored> {
  await getAcctSettings(orgId);
  const [s] = await db.select({ v: schema.acctSettings.xeSettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
  return (s?.v ?? {}) as Stored;
}
const save = (orgId: string, v: Stored) => db.update(schema.acctSettings).set({ xeSettings: v }).where(eq(schema.acctSettings.organisationId, orgId));

export async function getXeSettings(orgId: string) {
  const s = await stored(orgId);
  return { connected: !!(s.accountId && s.apiKeyEnc), accountId: s.accountId ?? null, keyHint: s.keyHint ?? null, lastAt: s.lastAt ?? null, lastTarget: s.lastTarget ?? null, lastRates: s.lastRates ?? {}, lastError: s.lastError ?? null };
}

export async function updateXeSettings(a: Actor, input: z.infer<typeof XeSettingsInput>) {
  const s = await stored(a.orgId);
  const next: Stored = { ...s, accountId: input.accountId || null };
  if (input.apiKey === null) { next.apiKeyEnc = null; next.keyHint = null; }
  else if (input.apiKey) { next.apiKeyEnc = encrypt(input.apiKey); next.keyHint = `${input.apiKey.slice(0, 3)}…${input.apiKey.slice(-3)}`; }
  if (!next.accountId || !next.apiKeyEnc) { next.lastRates = {}; next.lastAt = null; next.lastError = null; }
  // Check the credentials with a real (one-currency) request before saving, so mistakes show here.
  if (next.accountId && next.apiKeyEnc && (input.apiKey || next.accountId !== s.accountId)) {
    const target = (await getAcctSettings(a.orgId)).reportingCurrency ?? "gbp";
    const r = await (g.__xeFetch ?? xeFetch)({ accountId: next.accountId, apiKey: decrypt(next.apiKeyEnc), target, sources: [target === "eur" ? "usd" : "eur"] });
    next.lastRates = invertRates(target, r.quotes); next.lastTarget = target; next.lastAt = r.timestamp; next.lastError = null;
  }
  cache.clear();
  await db.transaction(async (tx) => {
    await tx.update(schema.acctSettings).set({ xeSettings: next, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctSettings.organisationId, a.orgId));
    await acctAudit(tx, { ...a, action: "xe_settings.updated", entity: "settings", entityId: "xe", old: { accountId: s.accountId ?? null, keyHint: s.keyHint ?? null }, new: { accountId: next.accountId, keyHint: next.keyHint, keyChanged: input.apiKey !== undefined } });
  });
  return getXeSettings(a.orgId);
}

/** Live XE mid-market rates "1 source = rate target", or null when XE is not connected. */
export async function xeRates(orgId: string, target: string, sources: string[]): Promise<XeRates | null> {
  const s = await stored(orgId);
  if (!s.accountId || !s.apiKeyEnc) return null;
  const need = [...new Set(sources.map((x) => x.toLowerCase()))].filter((x) => x !== target).sort();
  if (!need.length) return { rates: {}, at: new Date().toISOString(), source: "XE mid-market rate" };
  const key = `${orgId}|${target}|${need.join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const r = await (g.__xeFetch ?? xeFetch)({ accountId: s.accountId, apiKey: decrypt(s.apiKeyEnc), target, sources: need });
    const value: XeRates = { rates: invertRates(target, r.quotes), at: r.timestamp, source: "XE mid-market rate" };
    cache.set(key, { at: Date.now(), value });
    await save(orgId, { ...s, lastRates: { ...(s.lastTarget === target ? s.lastRates : {}), ...value.rates }, lastTarget: target, lastAt: value.at, lastError: null });
    return value;
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : "XE request failed";
    log.warn("accounting.xe_rates_failed", { orgId, error: msg });
    await save(orgId, { ...s, lastError: msg });
    // Last good rates (same target, under 24 h old, covering every currency) are better than none — marked as such.
    const age = s.lastAt ? Date.now() - Date.parse(s.lastAt) : Infinity;
    if (s.lastTarget === target && age < 86_400_000 && need.every((c) => s.lastRates?.[c])) return { rates: Object.fromEntries(need.map((c) => [c, s.lastRates![c]!])), at: s.lastAt!, source: "XE mid-market rate (last known)", stale: true };
    return null;
  }
}
