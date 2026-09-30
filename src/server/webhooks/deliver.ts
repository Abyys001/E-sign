import http from "node:http";
import https from "node:https";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { audit } from "../audit";
import { decrypt, encrypt, randomId } from "../crypto";
import { QUEUES, enqueue } from "../jobs";
import { log } from "../logger";
import { getOrgSettings } from "../settings";
import { assertPublicHttpsUrl } from "../kit/webhooks/ssrf-guard";
import { backoffWithJitter, signWebhook } from "../kit/webhooks/standard-webhooks";

/** Secrets use the Standard Webhooks `whsec_<base64>` format and are shown to the user exactly once. */
export function newWebhookSecret(): { secret: string; enc: string } {
  const secret = `whsec_${Buffer.from(Buffer.from(randomId(32), "base64url")).toString("base64")}`;
  return { secret, enc: encrypt(secret) };
}

/** Resolve a target and return the IP to pin. Private targets are refused unless explicitly enabled (dev/test only). */
export async function resolveTarget(rawUrl: string): Promise<{ url: URL; address: string | null }> {
  if (env().WEBHOOK_ALLOW_PRIVATE_TARGETS === "true") {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("webhook endpoints must use http(s)");
    return { url, address: null };
  }
  const r = await assertPublicHttpsUrl(rawUrl);
  return { url: r.url, address: r.address };
}

function post(url: URL, address: string | null, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`, method: "POST", timeout: timeoutMs,
      headers: { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "user-agent": "Bilit.event-E-Sign-Webhooks/1.0" },
      servername: url.hostname,
      // Connect to the IP we validated, not whatever DNS says a moment later (rebinding defence). Redirects are never followed.
      lookup: address ? (_h, _o, cb) => cb(null, address, address.includes(":") ? 6 : 4) : undefined,
    } as https.RequestOptions, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (out.length < 2000) out += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: out.slice(0, 500) }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

export type DeliveryResult = { status: "SUCCESS" | "FAILED" | "RETRY"; statusCode?: number; error?: string };

/** One delivery attempt. Failed attempts reschedule themselves with exponential backoff + jitter; the row is the audit log. */
export async function deliverWebhook(deliveryId: string): Promise<DeliveryResult> {
  const [row] = await db.select({ d: schema.webhookDeliveries, h: schema.webhooks }).from(schema.webhookDeliveries).innerJoin(schema.webhooks, eq(schema.webhooks.id, schema.webhookDeliveries.webhookId)).where(eq(schema.webhookDeliveries.id, deliveryId));
  if (!row) return { status: "FAILED", error: "delivery not found" };
  const { d, h } = row;
  if (d.status === "SUCCESS") return { status: "SUCCESS" };
  if (d.organisationId !== h.organisationId) throw new Error("tenant mismatch on webhook delivery");
  const s = await getOrgSettings(d.organisationId);
  const attempt = d.attempts + 1;
  const body = JSON.stringify({ ...(d.payload as object), id: d.id });
  let result: DeliveryResult;
  try {
    if (!h.enabled) throw new Error("endpoint disabled");
    const target = await resolveTarget(h.url);
    const sig = signWebhook([decrypt(h.secretEnc)], d.id, body);
    const res = await post(target.url, target.address, body, { ...sig, "x-webhook-id": sig["webhook-id"], "x-webhook-timestamp": sig["webhook-timestamp"], "x-webhook-signature": sig["webhook-signature"] }, s.webhooks.timeoutSeconds * 1000);
    if (res.status >= 200 && res.status < 300) result = { status: "SUCCESS", statusCode: res.status };
    else result = { status: attempt >= s.webhooks.maxAttempts ? "FAILED" : "RETRY", statusCode: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { status: attempt >= s.webhooks.maxAttempts ? "FAILED" : "RETRY", error: msg.slice(0, 300) };
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.webhookDeliveries).set({
      attempts: attempt, lastStatusCode: result.statusCode ?? null, lastError: result.error ?? null,
      status: result.status === "SUCCESS" ? "SUCCESS" : result.status === "FAILED" ? "FAILED" : "PENDING", deliveredAt: result.status === "SUCCESS" ? new Date() : null,
    }).where(eq(schema.webhookDeliveries.id, d.id));
    if (result.status === "FAILED") await audit(tx, { organisationId: d.organisationId, eventType: "webhook.delivery_failed", metadata: { deliveryId: d.id, event: d.event, url: new URL(h.url).origin, error: result.error } });
    if (result.status === "RETRY") {
      const delaySec = Math.max(5, Math.ceil(backoffWithJitter(attempt, 10_000, 6 * 3_600_000) / 1000));
      await enqueue(tx, QUEUES.webhook, { deliveryId: d.id }, { startAfter: delaySec, singletonKey: `${d.id}:${attempt}` });
    }
  });
  if (result.status !== "SUCCESS") log.warn("webhook.attempt_failed", { deliveryId: d.id, attempt, err: result.error });
  return result;
}

export async function redeliver(orgId: string, deliveryId: string) {
  const [d] = await db.select().from(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.id, deliveryId), eq(schema.webhookDeliveries.organisationId, orgId)));
  if (!d) return null;
  await db.update(schema.webhookDeliveries).set({ status: "PENDING", attempts: sql`greatest(${schema.webhookDeliveries.attempts} - 1, 0)` }).where(eq(schema.webhookDeliveries.id, deliveryId));
  await enqueue(null, QUEUES.webhook, { deliveryId }, { singletonKey: `${deliveryId}:manual:${Date.now()}` });
  return d;
}
