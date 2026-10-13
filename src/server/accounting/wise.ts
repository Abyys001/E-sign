import { createSign, generateKeyPairSync } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { currencyExponent, parseMajor } from "@/lib/money";
import type { RequestContext } from "../audit";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import { log } from "../logger";
import { acctAudit, accountingEnabled } from "./core";

/**
 * Wise bank feed (read-only). The admin creates a read-only API token in Wise Business and pastes it here; Bilit then
 * imports outgoing transfers (who was paid, how much, reference) and — once the generated public key is uploaded to
 * Wise for strong customer authentication — balance statements (incoming Stripe payouts, conversions, fees).
 * Nothing is ever sent or changed in Wise. Imported transfers are matched to recorded organiser payments; unmatched
 * ones can be recorded with one click. Wise is real money, so everything here belongs to the LIVE books.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };
const BASE = "https://api.wise.com";

// ---------- API client (injectable for tests) ----------
export type WiseProfile = { id: string; type: string; name: string };
export type WiseBalance = { id: string; currency: string; amount: number };
export type WiseTransfer = { id: number; status: string; created: string; sourceValue: number; sourceCurrency: string; targetValue: number; targetCurrency: string; reference?: string | null; targetAccount?: number | null; details?: { reference?: string | null } | null; rate?: number };
export type WiseStatementLine = { type: "DEBIT" | "CREDIT"; date: string; amount: { value: number; currency: string }; totalFees?: { value: number } | null; referenceNumber: string; details?: { type?: string; description?: string; senderName?: string; paymentReference?: string; recipient?: { name?: string } | null; merchant?: { name?: string } | null } | null };
export interface WiseApi {
  profiles(token: string): Promise<WiseProfile[]>;
  balances(token: string, profileId: string): Promise<WiseBalance[]>;
  transfers(token: string, profileId: string, p: { createdDateStart: string; offset: number; limit: number }): Promise<WiseTransfer[]>;
  recipientName(token: string, accountId: number): Promise<string | null>;
  statement(token: string, profileId: string, b: { id: string; currency: string }, p: { start: string; end: string }, privateKeyPem: string | null): Promise<WiseStatementLine[]>;
  /** Activity feed (no SCA needed): every money movement with its direction, incl. incoming payouts and card spend. */
  activities(token: string, profileId: string, p: { since: string; until: string; cursor?: string | null }): Promise<{ activities: WiseActivity[]; cursor: string | null }>;
  /** Mid-market rate source → target (reporting conversions only). Optional so test doubles can leave it out. */
  rate?(token: string, source: string, target: string): Promise<number>;
}
export type WiseActivity = { id: string; type: string; resource?: { type?: string; id?: string } | null; title?: string | null; description?: string | null; primaryAmount?: string | null; secondaryAmount?: string | null; status?: string | null; createdOn: string };
export class WiseScaError extends Error {}

function wiseError(status: number, said: string): AppError {
  const msg = said.replace(/[A-Za-z0-9]{8}-[A-Za-z0-9-]{20,}/g, "…").slice(0, 300);
  if (status === 401) return new AppError("validation_failed", `Wise rejected the API token (${msg || "unauthorised"}). Create a new read-only token in Wise → Settings → API tokens.`, [{ path: "token", message: "Invalid or revoked token" }]);
  if (status === 403) return new AppError("invalid_state", `Wise refused access (${msg || "forbidden"}).`);
  if (status === 429) return new AppError("invalid_state", "Wise rate limit reached — try again in a minute.");
  return new AppError("invalid_state", `Wise API error (HTTP ${status}) ${msg}`.trim());
}

async function call(token: string, path: string, headers: Record<string, string> = {}) {
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) }); }
  catch { throw new AppError("invalid_state", "Could not reach Wise. Try again in a moment."); }
  return res;
}
async function json<T>(token: string, path: string): Promise<T> {
  const res = await call(token, path);
  if (!res.ok) throw wiseError(res.status, await res.text().catch(() => ""));
  return res.json() as Promise<T>;
}

const realApi: WiseApi = {
  async rate(token, source, target) {
    const rows = await json<Array<{ rate: number }>>(token, `/v1/rates?source=${encodeURIComponent(source.toUpperCase())}&target=${encodeURIComponent(target.toUpperCase())}`);
    const r = Number(rows[0]?.rate);
    if (!Number.isFinite(r) || r <= 0) throw new AppError("invalid_state", "Wise returned no rate.");
    return r;
  },
  async activities(token, profileId, p) {
    const qs = new URLSearchParams({ since: p.since, until: p.until, size: "100" });
    if (p.cursor) qs.set("nextCursor", p.cursor);
    const b = await json<{ activities?: WiseActivity[]; cursor?: string | null }>(token, `/v1/profiles/${encodeURIComponent(profileId)}/activities?${qs}`);
    return { activities: b.activities ?? [], cursor: b.cursor ?? null };
  },
  async profiles(token) {
    const rows = await json<Array<{ id: number; type: string; businessName?: string; fullName?: string; details?: { name?: string; firstName?: string; lastName?: string } }>>(token, "/v2/profiles");
    return rows.map((p) => ({ id: String(p.id), type: String(p.type).toUpperCase(), name: p.businessName ?? p.details?.name ?? p.fullName ?? [p.details?.firstName, p.details?.lastName].filter(Boolean).join(" ") ?? String(p.id) }));
  },
  async balances(token, profileId) {
    const rows = await json<Array<{ id: number; currency: string; amount: { value: number; currency: string } }>>(token, `/v4/profiles/${encodeURIComponent(profileId)}/balances?types=STANDARD`);
    return rows.map((b) => ({ id: String(b.id), currency: b.currency.toLowerCase(), amount: toMinor(b.amount.value, b.currency) }));
  },
  async transfers(token, profileId, p) {
    return json<WiseTransfer[]>(token, `/v1/transfers?profile=${encodeURIComponent(profileId)}&createdDateStart=${encodeURIComponent(p.createdDateStart)}&limit=${p.limit}&offset=${p.offset}`);
  },
  async recipientName(token, accountId) {
    for (const path of [`/v1/accounts/${accountId}`, `/v2/accounts/${accountId}`]) {
      const res = await call(token, path);
      if (!res.ok) continue;
      const b = await res.json().catch(() => null) as { accountHolderName?: string; name?: { fullName?: string } | string } | null;
      const n = b?.accountHolderName ?? (typeof b?.name === "string" ? b.name : b?.name?.fullName);
      if (n) return n;
    }
    return null;
  },
  async statement(token, profileId, b, p, privateKeyPem) {
    const path = `/v1/profiles/${encodeURIComponent(profileId)}/balance-statements/${encodeURIComponent(b.id)}/statement.json?currency=${b.currency.toUpperCase()}&intervalStart=${encodeURIComponent(p.start)}&intervalEnd=${encodeURIComponent(p.end)}&type=COMPACT`;
    let res = await call(token, path);
    // Strong customer authentication: Wise answers 403 with a one-time token that must be signed with our private key.
    const ott = res.headers.get("x-2fa-approval");
    if (res.status === 403 && ott) {
      if (!privateKeyPem) throw new WiseScaError("Statements need the public key uploaded to Wise.");
      const signature = createSign("SHA256").update(ott).sign(privateKeyPem, "base64");
      res = await call(token, path, { "x-2fa-approval": ott, "X-Signature": signature });
      if (res.status === 403) throw new WiseScaError("Wise did not accept the signature — upload the public key shown on the Wise page to Wise → API tokens → Manage public keys.");
    }
    if (!res.ok) throw wiseError(res.status, await res.text().catch(() => ""));
    const body = await res.json() as { transactions?: WiseStatementLine[] };
    return body.transactions ?? [];
  },
};
const g = globalThis as { __wiseApi?: WiseApi };
export const setWiseApi = (a: WiseApi | null) => { g.__wiseApi = a ?? undefined; };
const api = () => g.__wiseApi ?? realApi;

const toMinor = (value: number, currency: string) => Math.abs(parseMajor(Math.abs(value).toFixed(currencyExponent(currency.toLowerCase())), currency.toLowerCase()));
const strip = (h: string | null | undefined) => (h ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
/** "<positive>+ 4,000 GBP</positive>" → { incoming: true, amount: 400000, currency: "gbp" }; null when not a single amount. */
export function parseActivityAmount(h: string | null | undefined) {
  const incoming = /<positive>/i.test(h ?? "") || /^\s*\+/.test(strip(h));
  const m = strip(h).replace(/^[+-]\s*/, "").match(/^([\d,]+(?:\.\d+)?)\s+([A-Z]{3})$/);
  if (!m) return null;
  const currency = m[2]!.toLowerCase();
  return { incoming, currency, amount: toMinor(Number(m[1]!.replace(/,/g, "")), currency) };
}
const ACT_KIND: Record<string, string> = { TRANSFER: "TRANSFER", CARD_PAYMENT: "CARD", CARD_CHECK: "CARD", CONVERSION: "CONVERSION", BALANCE_DEPOSIT: "DEPOSIT", DEPOSIT: "DEPOSIT", DIRECT_DEBIT_TRANSACTION: "OTHER", BALANCE_CASHBACK: "OTHER", BALANCE_INTEREST: "OTHER", FEE_REFUND: "FEE", ACCRUAL_CHARGE: "FEE" };
const wiseDate = (s: string) => new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`); // transfers API returns "2026-10-07 10:12:13" in UTC

// ---------- connection ----------
const TokenInput = z.preprocess((v) => (typeof v === "string" ? v.replace(/[\s"'`​-‍﻿]/g, "") : v), z.string().min(20, "That does not look like a complete Wise API token").max(200).regex(/^[A-Za-z0-9-]+$/, "A Wise API token contains only letters, digits and dashes"));
export const ConnectInput = z.object({ token: TokenInput, profileId: z.string().max(40).optional().nullable() });
export const ProfileInput = z.object({ profileId: z.string().min(1).max(40) });
export const IgnoreInput = z.object({ ignored: z.boolean(), reason: z.string().trim().max(500).optional().nullable() });

async function connection(orgId: string) {
  const [c] = await db.select().from(schema.acctWiseConnections).where(eq(schema.acctWiseConnections.organisationId, orgId));
  return c ?? null;
}

export async function getWiseStatus(orgId: string) {
  const c = await connection(orgId);
  if (!c) return { connected: false as const };
  const [n] = await db.select({ toRecord: sql<number>`count(*) filter (where direction = 'OUT' and kind = 'TRANSFER' and organiser_payment_id is null and bill_id is null and partner_payment_id is null and not ignored and coalesce(status, '') not in ('cancelled', 'bounced_back', 'funds_refunded', 'charged_back'))::int`, total: sql<number>`count(*)::int` })
    .from(schema.acctWiseTransactions).where(eq(schema.acctWiseTransactions.organisationId, orgId));
  return { connected: true as const, tokenHint: c.tokenHint, profileId: c.profileId, profileName: c.profileName, publicKey: c.scaPublicKey, balances: c.balances as WiseBalance[], status: c.status, statementsOk: c.statementsOk, lastSyncAt: c.lastSyncAt, lastError: c.lastError, toRecord: n?.toRecord ?? 0, total: n?.total ?? 0 };
}

export async function connectWise(a: Actor, input: z.infer<typeof ConnectInput>) {
  const profiles = await api().profiles(input.token);
  if (!profiles.length) throw new AppError("validation_failed", "This token has no Wise profiles.", [{ path: "token", message: "No profiles" }]);
  const profile = profiles.find((p) => p.id === input.profileId) ?? profiles.find((p) => p.type === "BUSINESS") ?? profiles[0]!;
  const existing = await connection(a.orgId);
  // Key pair for strong customer authentication (statements). Kept when reconnecting so the uploaded public key stays valid.
  let priv = existing?.scaPrivateKeyEnc ?? null, pub = existing?.scaPublicKey ?? null;
  if (!priv || !pub) {
    const kp = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    priv = encrypt(kp.privateKey); pub = kp.publicKey;
  }
  const values = { tokenEnc: encrypt(input.token), tokenHint: `${input.token.slice(0, 4)}…${input.token.slice(-4)}`, profileId: profile.id, profileName: `${profile.name} (${profile.type.toLowerCase()})`, scaPrivateKeyEnc: priv, scaPublicKey: pub, status: "CONNECTED", lastError: null, updatedAt: new Date() };
  await db.transaction(async (tx) => {
    if (existing) await tx.update(schema.acctWiseConnections).set(values).where(eq(schema.acctWiseConnections.id, existing.id));
    else await tx.insert(schema.acctWiseConnections).values({ organisationId: a.orgId, createdBy: a.userId, ...values });
    await acctAudit(tx, { ...a, action: "wise.connected", entity: "wise", entityId: profile.id, new: { profile: values.profileName, tokenHint: values.tokenHint } });
  });
  return { ...(await getWiseStatus(a.orgId)), profiles };
}

export async function listWiseProfiles(orgId: string) {
  const c = await connection(orgId);
  if (!c) throw new AppError("invalid_state", "Connect Wise first.");
  return api().profiles(decrypt(c.tokenEnc));
}

export async function setWiseProfile(a: Actor, profileId: string) {
  const c = await connection(a.orgId);
  if (!c) throw new AppError("invalid_state", "Connect Wise first.");
  const p = (await api().profiles(decrypt(c.tokenEnc))).find((x) => x.id === profileId);
  if (!p) throw new AppError("validation_failed", "That profile is not available for this token.");
  await db.transaction(async (tx) => {
    await tx.update(schema.acctWiseConnections).set({ profileId: p.id, profileName: `${p.name} (${p.type.toLowerCase()})`, balances: [], statementsOk: false, lastSyncAt: null, updatedAt: new Date() }).where(eq(schema.acctWiseConnections.id, c.id));
    await acctAudit(tx, { ...a, action: "wise.profile_changed", entity: "wise", entityId: p.id, old: { profile: c.profileName }, new: { profile: p.name } });
  });
  return getWiseStatus(a.orgId);
}

/** Removes the token and keys. Imported transactions stay (they are part of the audit trail). */
export async function disconnectWise(a: Actor) {
  const c = await connection(a.orgId);
  if (!c) return { connected: false };
  await db.transaction(async (tx) => {
    await tx.delete(schema.acctWiseConnections).where(eq(schema.acctWiseConnections.id, c.id));
    await acctAudit(tx, { ...a, action: "wise.disconnected", entity: "wise", entityId: c.profileId ?? "wise", old: { profile: c.profileName, tokenHint: c.tokenHint } });
  });
  return { connected: false };
}

// ---------- sync ----------
const KIND: Record<string, string> = { TRANSFER: "TRANSFER", DEPOSIT: "DEPOSIT", MONEY_ADDED: "DEPOSIT", CONVERSION: "CONVERSION", CARD: "CARD", ACCRUAL_CHARGE: "FEE", DIRECT_DEBIT: "OTHER" };
const DEAD = ["cancelled", "bounced_back", "funds_refunded", "charged_back"];
const running = new Set<string>();

export async function syncWise(orgId: string, opts: { userId?: string | null; ctx?: RequestContext } = {}) {
  const c = await connection(orgId);
  if (!c || !c.profileId) throw new AppError("invalid_state", "Connect Wise first.");
  if (running.has(orgId)) throw new AppError("conflict", "A Wise sync is already running.");
  running.add(orgId);
  const token = decrypt(c.tokenEnc), w = api(), pid = c.profileId;
  const now = new Date();
  const since = new Date((c.lastSyncAt ?? new Date(now.getTime() - 400 * 86_400_000)).getTime() - 14 * 86_400_000); // overlap catches late status changes
  const stats = { transfers: 0, activities: 0, statementLines: 0, statementsOk: c.statementsOk, error: null as string | null };
  try {
    const balances = await w.balances(token, pid);
    // Outgoing transfers.
    const names = new Map<number, string | null>();
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await w.transfers(token, pid, { createdDateStart: since.toISOString(), offset, limit: 100 });
      for (const t of page) {
        let counterparty: string | null = null;
        if (t.targetAccount) { if (!names.has(t.targetAccount)) names.set(t.targetAccount, await w.recipientName(token, t.targetAccount).catch(() => null)); counterparty = names.get(t.targetAccount) ?? null; }
        const row = {
          organisationId: orgId, wiseId: `TRANSFER-${t.id}`, source: "TRANSFER", direction: "OUT", kind: "TRANSFER", status: t.status, occurredAt: wiseDate(t.created),
          amount: toMinor(t.targetValue, t.targetCurrency), currency: t.targetCurrency.toLowerCase(), sourceAmount: toMinor(t.sourceValue, t.sourceCurrency), sourceCurrency: t.sourceCurrency.toLowerCase(),
          counterparty, reference: (t.reference ?? t.details?.reference ?? null) || null, raw: { id: t.id, status: t.status, rate: t.rate ?? null, targetAccount: t.targetAccount ?? null },
        };
        await db.insert(schema.acctWiseTransactions).values(row).onConflictDoUpdate({ target: [schema.acctWiseTransactions.organisationId, schema.acctWiseTransactions.wiseId], set: {
          source: "TRANSFER", status: row.status, occurredAt: row.occurredAt, amount: row.amount, currency: row.currency, sourceAmount: row.sourceAmount, sourceCurrency: row.sourceCurrency, reference: row.reference, raw: row.raw,
          counterparty: sql`case when ${schema.acctWiseTransactions.direction} = 'IN' then ${schema.acctWiseTransactions.counterparty} else coalesce(${row.counterparty}, ${schema.acctWiseTransactions.counterparty}) end`, updatedAt: new Date() } });
        stats.transfers++;
      }
      if (page.length < 100) break;
    }
    // Activity feed: true direction (incoming Stripe payouts are "transfers" to ourselves in the transfers API), total
    // debited incl. Wise fee, card spend, conversions and deposits.
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const page: { activities: WiseActivity[]; cursor: string | null } = await w.activities(token, pid, { since: since.toISOString(), until: now.toISOString(), cursor });
      for (const act of page.activities) {
        const prim = parseActivityAmount(act.primaryAmount), sec = parseActivityAmount(act.secondaryAmount);
        const title = strip(act.title) || null, desc = strip(act.description) || null;
        const status = (act.status ?? "").toLowerCase() || null;
        const rid = act.resource?.id ?? null;
        if (act.type === "TRANSFER" && rid) {
          const [t] = await db.select().from(schema.acctWiseTransactions).where(and(eq(schema.acctWiseTransactions.organisationId, orgId), eq(schema.acctWiseTransactions.wiseId, `TRANSFER-${rid}`)));
          if (prim?.incoming) {
            await db.insert(schema.acctWiseTransactions).values({ organisationId: orgId, wiseId: `TRANSFER-${rid}`, source: "ACTIVITY", direction: "IN", kind: "DEPOSIT", status, occurredAt: new Date(act.createdOn), amount: prim.amount, currency: prim.currency, counterparty: title, description: desc, raw: { activity: act.id } })
              .onConflictDoUpdate({ target: [schema.acctWiseTransactions.organisationId, schema.acctWiseTransactions.wiseId], set: { direction: "IN", kind: "DEPOSIT", counterparty: title, description: desc, fee: null, updatedAt: new Date() } });
          } else if (t && sec && t.sourceCurrency === sec.currency && t.sourceAmount != null && sec.amount >= t.sourceAmount) {
            await db.update(schema.acctWiseTransactions).set({ fee: sec.amount - t.sourceAmount || null, updatedAt: new Date() }).where(eq(schema.acctWiseTransactions.id, t.id));
          }
          continue;
        }
        if (!prim) continue;
        const kind = ACT_KIND[act.type] ?? "OTHER";
        await db.insert(schema.acctWiseTransactions).values({ organisationId: orgId, wiseId: `ACT-${act.resource?.type ?? act.type}-${rid ?? act.id}`, source: "ACTIVITY", direction: prim.incoming ? "IN" : "OUT", kind, status, occurredAt: new Date(act.createdOn),
          amount: prim.amount, currency: prim.currency, sourceAmount: sec && sec.currency !== prim.currency ? sec.amount : null, sourceCurrency: sec && sec.currency !== prim.currency ? sec.currency : null, counterparty: title, description: desc, raw: { activity: act.id, type: act.type } })
          .onConflictDoUpdate({ target: [schema.acctWiseTransactions.organisationId, schema.acctWiseTransactions.wiseId], set: { status, amount: prim.amount, currency: prim.currency, counterparty: title, description: desc, updatedAt: new Date() } });
        stats.activities++;
      }
      cursor = page.cursor;
      if (!cursor || !page.activities.length) break;
    }
    // Balance statements (optional, need strong customer authentication; the activity feed covers the essentials).
    const key = c.scaPrivateKeyEnc ? decrypt(c.scaPrivateKeyEnc) : null;
    try {
      for (const b of balances) {
        const lines = await w.statement(token, pid, b, { start: since.toISOString(), end: now.toISOString() }, key);
        for (const l of lines) {
          const cur = l.amount.currency.toLowerCase();
          const dir = l.type === "DEBIT" ? "OUT" : "IN";
          const fee = l.totalFees?.value ? toMinor(l.totalFees.value, cur) : null;
          const isTransfer = dir === "OUT" && /^TRANSFER-\d+$/.test(l.referenceNumber);
          const wiseId = isTransfer ? l.referenceNumber : `${l.referenceNumber}:${cur}:${dir}`;
          const d = l.details ?? {};
          const row = {
            organisationId: orgId, wiseId, source: "STATEMENT", direction: dir, kind: KIND[String(d.type)] ?? "OTHER", status: "completed", occurredAt: new Date(l.date),
            amount: toMinor(l.amount.value, cur), currency: cur, fee, counterparty: d.senderName ?? d.recipient?.name ?? d.merchant?.name ?? null, reference: d.paymentReference ?? null, description: d.description ?? null,
            raw: { referenceNumber: l.referenceNumber, type: l.type, detailsType: d.type ?? null },
          };
          if (isTransfer) {
            // Same money as the transfer row: only add what the statement knows (fee, description); the transfer keeps the recipient amount.
            await db.insert(schema.acctWiseTransactions).values({ ...row, kind: "TRANSFER" }).onConflictDoUpdate({ target: [schema.acctWiseTransactions.organisationId, schema.acctWiseTransactions.wiseId], set: { fee: row.fee, description: row.description, updatedAt: new Date() } });
          } else {
            await db.insert(schema.acctWiseTransactions).values(row).onConflictDoUpdate({ target: [schema.acctWiseTransactions.organisationId, schema.acctWiseTransactions.wiseId], set: { amount: row.amount, fee: row.fee, counterparty: row.counterparty, reference: row.reference, description: row.description, updatedAt: new Date() } });
          }
          stats.statementLines++;
        }
      }
      stats.statementsOk = true;
    } catch (e) {
      if (!(e instanceof WiseScaError)) throw e;
      stats.statementsOk = false; stats.error = e.message;
    }
    await db.update(schema.acctWiseConnections).set({ balances, statementsOk: stats.statementsOk, lastSyncAt: now, status: "CONNECTED", lastError: stats.error, updatedAt: new Date() }).where(eq(schema.acctWiseConnections.id, c.id));
    await relinkWise(orgId);
    if (opts.userId) await db.transaction((tx) => acctAudit(tx, { orgId, userId: opts.userId, ctx: opts.ctx, action: "wise.synced", entity: "wise", entityId: pid, new: stats }));
    return stats;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.update(schema.acctWiseConnections).set({ status: "ERROR", lastError: msg, updatedAt: new Date() }).where(eq(schema.acctWiseConnections.id, c.id));
    log.warn("accounting.wise_sync_failed", { orgId, error: msg });
    throw e;
  } finally { running.delete(orgId); }
}

/** Scheduled (worker): sync every connected organisation. */
export async function syncAllWise() {
  if (!accountingEnabled()) return 0;
  const cs = await db.select({ orgId: schema.acctWiseConnections.organisationId }).from(schema.acctWiseConnections);
  let n = 0;
  for (const c of cs) { try { await syncWise(c.orgId); n++; } catch { /* logged in syncWise */ } }
  return n;
}

/** The number Bilit writes in references for a Wise movement ("Wise #<n>"): transfer id or activity resource id. */
export const wiseRefNumber = (wiseId: string) => wiseId.replace(/^TRANSFER-/, "").replace(/^ACT-[A-Z_]+-/, "").split(":")[0]!;

// ---------- matching ----------
const norm = (s: string | null | undefined) => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(ltd|limited|gmbh|ab|aps|as|llc|fz|fze|inc|bv|sarl|sas|srl|the|and|&)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const GENERIC = new Set(["events", "event", "entertainment", "productions", "production", "promotions", "promotion", "music", "group", "media", "live", "company", "co", "international", "global", "services", "management", "agency", "tickets", "ticketing"]);
function nameScore(a: string, b: string) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const keep = (t: string) => t.length > 1 && !GENERIC.has(t);
  const ta = new Set(x.split(" ").filter(keep)), tb = new Set(y.split(" ").filter(keep));
  if (!ta.size || !tb.size) return 0;
  const common = [...ta].filter((t) => tb.has(t)).length;
  return common / Math.max(1, Math.min(ta.size, tb.size));
}

/**
 * Link Wise transfers to organiser payments (reference contains the transfer id, else one unlinked bank-transfer payment
 * with the same amount/currency within ±3 days), suggest the organiser by recipient name, and match incoming money to
 * Stripe payouts. Only links — the ledger is never touched here.
 */
export async function relinkWise(orgId: string) {
  const w = schema.acctWiseTransactions, p = schema.acctOrganiserPayments;
  // Supplier invoices / expenses: linked by the Wise number in their payment reference; voided ones lose the link.
  await db.execute(sql`update acct_wise_transactions t set bill_id = null, updated_at = now() from acct_bills b where b.id = t.bill_id and b.status = 'VOIDED' and t.organisation_id = ${orgId}`);
  const unbilled = await db.select({ id: w.id, wiseId: w.wiseId }).from(w).where(and(eq(w.organisationId, orgId), eq(w.direction, "OUT"), isNull(w.billId), isNull(w.organiserPaymentId)));
  if (unbilled.length) {
    const bills = await db.select({ id: schema.acctBills.id, ref: schema.acctBills.paymentReference }).from(schema.acctBills).where(and(eq(schema.acctBills.organisationId, orgId), eq(schema.acctBills.livemode, true), sql`${schema.acctBills.status} <> 'VOIDED'`, sql`${schema.acctBills.paymentReference} is not null`));
    const used = new Set((await db.select({ id: w.billId }).from(w).where(and(eq(w.organisationId, orgId), sql`${w.billId} is not null`))).map((r) => r.id));
    for (const t of unbilled) {
      const n = wiseRefNumber(t.wiseId);
      const b = bills.find((x) => !used.has(x.id) && new RegExp(`(^|\\D)${n}(\\D|$)`).test(x.ref ?? ""));
      if (b) { used.add(b.id); await db.update(w).set({ billId: b.id, updatedAt: new Date() }).where(eq(w.id, t.id)); }
    }
  }
  // Profit-share partner payments (e.g. the developer), linked by the Wise number in their reference.
  const unp = await db.select({ id: w.id, wiseId: w.wiseId }).from(w).where(and(eq(w.organisationId, orgId), eq(w.direction, "OUT"), isNull(w.partnerPaymentId), isNull(w.billId), isNull(w.organiserPaymentId)));
  if (unp.length) {
    const pp = await db.select({ id: schema.acctPartnerPayments.id, ref: schema.acctPartnerPayments.bankReference }).from(schema.acctPartnerPayments).where(and(eq(schema.acctPartnerPayments.organisationId, orgId), eq(schema.acctPartnerPayments.livemode, true), eq(schema.acctPartnerPayments.status, "PAID"), sql`${schema.acctPartnerPayments.bankReference} is not null`));
    const usedP = new Set((await db.select({ id: w.partnerPaymentId }).from(w).where(and(eq(w.organisationId, orgId), sql`${w.partnerPaymentId} is not null`))).map((r) => r.id));
    for (const t of unp) {
      const n = wiseRefNumber(t.wiseId);
      const m2 = pp.find((x) => !usedP.has(x.id) && new RegExp(`(^|\\D)${n}(\\D|$)`).test(x.ref ?? ""));
      if (m2) { usedP.add(m2.id); await db.update(w).set({ partnerPaymentId: m2.id, updatedAt: new Date() }).where(eq(w.id, t.id)); }
    }
  }
  // Payments that were voided lose their link.
  await db.execute(sql`update acct_wise_transactions t set organiser_payment_id = null, updated_at = now() from acct_organiser_payments p where p.id = t.organiser_payment_id and p.status = 'VOIDED' and t.organisation_id = ${orgId}`);
  const outs = await db.select().from(w).where(and(eq(w.organisationId, orgId), eq(w.direction, "OUT"), eq(w.kind, "TRANSFER")));
  if (outs.length) {
    const pays = await db.select().from(p).where(and(eq(p.organisationId, orgId), eq(p.livemode, true), sql`${p.status} <> 'VOIDED'`));
    const num = (t: { wiseId: string }) => t.wiseId.replace(/^TRANSFER-/, "");
    // 1) A payment whose reference carries a Wise transfer number belongs to that transfer — this also corrects an
    //    earlier amount-based guess that picked the wrong transfer.
    const owner = new Map<string, string>(); // paymentId → tx id
    for (const t of outs) for (const x of pays) if (x.bankReference && new RegExp(`(^|\\D)${num(t)}(\\D|$)`).test(x.bankReference) && !owner.has(x.id)) owner.set(x.id, t.id);
    const linkOf = new Map(outs.map((t) => [t.id, t.organiserPaymentId] as const));
    for (const t of outs) {
      const mine = [...owner.entries()].find(([, txId]) => txId === t.id)?.[0] ?? null;
      const cur = linkOf.get(t.id) ?? null;
      if (mine && cur !== mine) linkOf.set(t.id, mine);
      else if (!mine && cur && owner.has(cur)) linkOf.set(t.id, null); // its payment belongs to another transfer
    }
    const taken = new Set([...linkOf.values()].filter(Boolean) as string[]);
    const orgs = await db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.organisationId, orgId));
    const holders = new Map(orgs.map((o) => { let h: string | null = null; try { h = o.bankDetailsEnc ? (JSON.parse(decrypt(o.bankDetailsEnc)) as { accountHolder?: string }).accountHolder ?? null : null; } catch { /* unreadable */ } return [o.id, h]; }));
    const score = (name: string, orgId2: string) => { const o = orgs.find((x) => x.id === orgId2)!; return Math.max(nameScore(name, o.name), o.companyName ? nameScore(name, o.companyName) : 0, holders.get(o.id) ? nameScore(name, holders.get(o.id)!) : 0); };
    for (const t of outs) {
      if (DEAD.includes(String(t.status)) || linkOf.get(t.id) || t.ignored || t.billId || t.partnerPaymentId) continue;
      // 2) Otherwise one unlinked bank-transfer payment with the same amount/currency within ±3 days — only when the
      //    recipient's name matches that payment's organiser (never for transfers to Bilit's own accounts or third parties).
      const day = t.occurredAt.toISOString().slice(0, 10);
      const near = (d: string) => Math.abs(Date.parse(`${d}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) <= 3 * 86_400_000;
      const c = pays.filter((x) => !taken.has(x.id) && !owner.has(x.id) && x.method === "BANK_TRANSFER" && x.currency === t.currency && x.amount === t.amount && near(x.paymentDate) && t.counterparty && score(t.counterparty, x.organiserId) >= 0.5);
      if (c.length === 1) { linkOf.set(t.id, c[0]!.id); taken.add(c[0]!.id); }
    }
    for (const t of outs) {
      const link = linkOf.get(t.id) ?? null;
      const pay = link ? pays.find((x) => x.id === link) : undefined;
      let suggested: string | null = pay?.organiserId ?? null;
      if (!suggested && t.counterparty) {
        const best = orgs.map((o) => ({ id: o.id, s: score(t.counterparty!, o.id) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.s >= 0.5) suggested = best.id;
      }
      if (link !== t.organiserPaymentId || suggested !== t.suggestedOrganiserId) await db.update(w).set({ organiserPaymentId: link, suggestedOrganiserId: suggested, updatedAt: new Date() }).where(eq(w.id, t.id));
    }
  }
  // Incoming money ↔ Stripe payouts (same amount and currency, arriving 0–5 days after the payout was created).
  const ins = await db.select().from(w).where(and(eq(w.organisationId, orgId), eq(w.direction, "IN"), isNull(w.stripePayoutId)));
  if (ins.length) {
    const used = new Set((await db.select({ id: w.stripePayoutId }).from(w).where(and(eq(w.organisationId, orgId), sql`${w.stripePayoutId} is not null`))).map((r) => r.id));
    const pos = await db.select().from(schema.stripePayouts).where(and(eq(schema.stripePayouts.organisationId, orgId), eq(schema.stripePayouts.livemode, true), eq(schema.stripePayouts.status, "paid")));
    for (const t of ins) {
      const c = pos.filter((x) => !used.has(x.payoutId) && x.currency === t.currency && x.amount === t.amount && t.occurredAt.getTime() - x.stripeCreatedAt.getTime() >= -86_400_000 && t.occurredAt.getTime() - x.stripeCreatedAt.getTime() <= 5 * 86_400_000)
        .sort((a, b) => Math.abs(t.occurredAt.getTime() - a.stripeCreatedAt.getTime()) - Math.abs(t.occurredAt.getTime() - b.stripeCreatedAt.getTime()));
      if (c[0]) { used.add(c[0].payoutId); await db.update(w).set({ stripePayoutId: c[0].payoutId, updatedAt: new Date() }).where(eq(w.id, t.id)); }
    }
  }
}

// ---------- listing / actions ----------
export const WiseFilter = z.object({ view: z.enum(["torecord", "spend", "out", "in", "all", "ignored"]).default("torecord"), q: z.string().trim().max(120).optional() });

export async function listWise(orgId: string, f: z.infer<typeof WiseFilter>, page: { limit: number; offset: number }) {
  await relinkWise(orgId);
  const w = schema.acctWiseTransactions;
  const where = and(eq(w.organisationId, orgId),
    f.view === "torecord" ? sql`${w.direction} = 'OUT' and ${w.kind} = 'TRANSFER' and ${w.organiserPaymentId} is null and ${w.billId} is null and ${w.partnerPaymentId} is null and not ${w.ignored} and coalesce(${w.status}, '') not in ('cancelled', 'bounced_back', 'funds_refunded', 'charged_back')`
      : f.view === "spend" ? sql`${w.direction} = 'OUT' and ${w.kind} in ('CARD', 'OTHER') and ${w.billId} is null and ${w.partnerPaymentId} is null and not ${w.ignored} and coalesce(${w.status}, '') <> 'cancelled'`
      : f.view === "out" ? sql`${w.direction} = 'OUT' and not ${w.ignored}` : f.view === "in" ? sql`${w.direction} = 'IN' and not ${w.ignored}` : f.view === "ignored" ? sql`${w.ignored}` : undefined,
    f.q ? sql`(${w.counterparty} ilike ${`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`} or ${w.reference} ilike ${`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`} or ${w.wiseId} ilike ${`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`})` : undefined);
  const sugg = schema.acctOrganisers;
  const [items, [cnt]] = await Promise.all([
    db.select({ t: w, paymentOrganiserId: schema.acctOrganiserPayments.organiserId, paymentDate: schema.acctOrganiserPayments.paymentDate, paymentStatus: schema.acctOrganiserPayments.status, suggestedName: sugg.name, billKind: schema.acctBills.kind, billSupplier: schema.acctBills.supplierName, partnerName: sql<string | null>`(select pp2.name from acct_partner_payments x join acct_profit_partners pp2 on pp2.id = x.partner_id where x.id = ${w.partnerPaymentId})`, paymentOrganiserName: sql<string | null>`(select name from acct_organisers o where o.id = ${schema.acctOrganiserPayments.organiserId})` })
      .from(w).leftJoin(schema.acctOrganiserPayments, eq(schema.acctOrganiserPayments.id, w.organiserPaymentId)).leftJoin(sugg, eq(sugg.id, w.suggestedOrganiserId)).leftJoin(schema.acctBills, eq(schema.acctBills.id, w.billId))
      .where(where).orderBy(desc(w.occurredAt)).limit(page.limit).offset(page.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(w).where(where),
  ]);
  return { items: items.map((r) => { const { raw: _raw, ...t } = r.t; void _raw; return { ...t, paymentOrganiserId: r.paymentOrganiserId, paymentOrganiserName: r.paymentOrganiserName, paymentDate: r.paymentDate, paymentStatus: r.paymentStatus, suggestedName: r.suggestedName, billKind: r.billKind, billSupplier: r.billSupplier, partnerName: r.partnerName, refNumber: wiseRefNumber(r.t.wiseId) }; }), total: cnt?.n ?? 0 };
}

export async function setWiseIgnored(a: Actor, id: string, input: z.infer<typeof IgnoreInput>) {
  const w = schema.acctWiseTransactions;
  const [t] = await db.select().from(w).where(and(eq(w.id, id), eq(w.organisationId, a.orgId)));
  if (!t) throw new AppError("not_found", "Wise transaction not found");
  if (input.ignored && !input.reason) throw new AppError("validation_failed", "Say what this transfer was (e.g. supplier, own account, salary).", [{ path: "reason", message: "Give a reason" }]);
  return db.transaction(async (tx) => {
    const [row] = await tx.update(w).set({ ignored: input.ignored, ignoredReason: input.ignored ? input.reason ?? null : null, ignoredBy: input.ignored ? a.userId : null, updatedAt: new Date() }).where(eq(w.id, id)).returning();
    await acctAudit(tx, { ...a, action: input.ignored ? "wise.tx_ignored" : "wise.tx_unignored", entity: "wise_transaction", entityId: id, new: { wiseId: t.wiseId, reason: input.reason ?? null } });
    return row!;
  });
}

// ---------- bulk ----------
export const BulkInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["ignore", "expense", "bill", "organiser", "partner"]),
  partnerId: z.string().uuid().optional().nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
  accountId: z.string().uuid().optional().nullable(),
  organiserId: z.string().uuid().optional().nullable(),
});

/**
 * Book many Wise movements in one go: one expense / paid supplier invoice / organiser payment per movement (each with
 * its own "Wise #<n>" reference so it links back), or mark them as not organiser payments. Each item is its own
 * transaction; failures are reported per item and do not stop the rest.
 */
export async function bulkWise(a: Actor, input: z.infer<typeof BulkInput>) {
  if (input.action === "ignore" && !input.reason) throw new AppError("validation_failed", "Say what these transfers were (e.g. own account, salary, loan).", [{ path: "reason", message: "Give a reason" }]);
  if ((input.action === "expense" || input.action === "bill") && !input.accountId) throw new AppError("validation_failed", "Choose an expense category.", [{ path: "accountId", message: "Choose a category" }]);
  if (input.action === "partner" && !input.partnerId) throw new AppError("validation_failed", "Choose the partner.", [{ path: "partnerId", message: "Choose a partner" }]);
  if (input.action === "organiser" && !input.organiserId) throw new AppError("validation_failed", "Choose the organiser.", [{ path: "organiserId", message: "Choose an organiser" }]);
  const { createBill } = await import("./books");
  const { recordOrganiserPayment } = await import("./manual");
  const w = schema.acctWiseTransactions;
  const rows = await db.select().from(w).where(and(eq(w.organisationId, a.orgId), sql`${w.id} in (${sql.join(input.ids.map((id) => sql`${id}::uuid`), sql`, `)})`));
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const t of rows) {
    try {
      if (t.organiserPaymentId || t.billId || t.partnerPaymentId) throw new AppError("invalid_state", "Already in the books.");
      if (input.action === "ignore") { await setWiseIgnored(a, t.id, { ignored: true, reason: input.reason }); results.push({ id: t.id, ok: true }); continue; }
      if (t.direction !== "OUT") throw new AppError("invalid_state", "Only money going out can be booked.");
      if (t.ignored) throw new AppError("invalid_state", "Marked as other — undo that first.");
      const ref = `Wise #${wiseRefNumber(t.wiseId)}`, date = t.occurredAt.toISOString().slice(0, 10);
      const fee = t.fee ? `, Wise fee ${(t.fee / 10 ** currencyExponent(t.sourceCurrency ?? t.currency)).toFixed(currencyExponent(t.sourceCurrency ?? t.currency))} ${(t.sourceCurrency ?? t.currency).toUpperCase()}` : "";
      const desc = `${t.kind === "CARD" ? "Wise card payment" : "Wise transfer"} to ${t.counterparty ?? "recipient"}${t.reference ? `, reference “${t.reference}”` : ""}${t.sourceCurrency && t.sourceCurrency !== t.currency && t.sourceAmount != null ? `, paid from ${(t.sourceAmount / 10 ** currencyExponent(t.sourceCurrency)).toFixed(currencyExponent(t.sourceCurrency))} ${t.sourceCurrency.toUpperCase()}` : ""}${fee}`;
      if (input.action === "partner") {
        const { recordPartnerPayment } = await import("./profit-share");
        await recordPartnerPayment(a, { mode: "live", partnerId: input.partnerId!, amount: t.amount, currency: t.currency, paymentDate: date, method: "BANK_TRANSFER", bankReference: ref, notes: desc });
      } else if (input.action === "organiser") {
        await recordOrganiserPayment(a, { mode: "live", organiserId: input.organiserId!, eventId: null, amount: t.amount, currency: t.currency, paymentDate: date, bankReference: ref, method: "BANK_TRANSFER", notes: desc, status: "PAID" });
      } else {
        const kind = input.action === "bill" ? "BILL" : "EXPENSE";
        await createBill(a, { mode: "live", kind, supplierName: (t.counterparty ?? "Unknown payee").slice(0, 200), supplierVat: null, country: null, invoiceNumber: kind === "BILL" ? t.reference?.slice(0, 80) ?? null : null, invoiceDate: date, dueDate: null, currency: t.currency, netAmount: t.amount, vatAmount: 0, accountId: input.accountId!, eventId: null, description: desc, paidFrom: t.kind === "CARD" ? "CARD" : "BANK", paidDate: kind === "BILL" ? date : null, paymentReference: ref });
      }
      results.push({ id: t.id, ok: true });
    } catch (e) { results.push({ id: t.id, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "failed" }); }
  }
  await relinkWise(a.orgId);
  return { done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: input.ids.length };
}

/** Live Wise mid-market rates into `target` for indicative reporting totals. Never throws: null when Wise is not connected or unreachable. */
export async function wiseRates(orgId: string, target: string, sources: string[]): Promise<{ rates: Record<string, string>; at: string } | null> {
  const c = await connection(orgId);
  const w = api();
  if (!c?.profileId || !w.rate) return null;
  try {
    const token = decrypt(c.tokenEnc), rates: Record<string, string> = {};
    for (const s of [...new Set(sources)].filter((x) => x !== target)) rates[s] = String(await w.rate(token, s, target));
    return { rates, at: new Date().toISOString() };
  } catch (e) { log.warn("accounting.wise_rates_failed", { orgId, error: e instanceof Error ? e.message : String(e) }); return null; }
}
