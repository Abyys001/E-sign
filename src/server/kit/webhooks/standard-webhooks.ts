import { createHmac, timingSafeEqual } from 'node:crypto';

/** Standard Webhooks v1 (https://github.com/standard-webhooks/standard-webhooks). HMAC-SHA256 only; ed25519 (`whsk_`) is not implemented. */

const SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_SECONDS = 300; // spec sets no value; 5 min is the common choice

export interface WebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

function keyOf(secret: string): Buffer {
  return Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, 'base64');
}

function sign(secret: string, id: string, timestamp: string, payload: string): string {
  return createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${payload}`).digest('base64');
}

/** `secrets` may hold two entries during rotation: the header then carries both signatures. */
export function signWebhook(
  secrets: string[],
  id: string,
  payload: string,
  now = new Date(),
): WebhookHeaders {
  if (secrets.length === 0) throw new Error('at least one secret required');
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': secrets.map((s) => `v1,${sign(s, id, timestamp, payload)}`).join(' '),
  };
}

export class WebhookVerificationError extends Error {}

/** `payload` must be the raw request body string, not re-serialized JSON. Dedupe on `webhook-id` at the consumer for replay safety. */
export function verifyWebhook(
  secrets: string[],
  headers: Partial<WebhookHeaders>,
  payload: string,
  now = new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): void {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!id || !ts || !sigHeader) throw new WebhookVerificationError('missing headers');

  const sent = Number(ts);
  if (!Number.isInteger(sent)) throw new WebhookVerificationError('invalid timestamp');
  if (Math.abs(Math.floor(now.getTime() / 1000) - sent) > toleranceSeconds) {
    throw new WebhookVerificationError('timestamp outside tolerance');
  }

  const presented = sigHeader.split(' ').flatMap((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig ? [Buffer.from(sig, 'base64')] : [];
  });
  for (const secret of secrets) {
    const expected = Buffer.from(sign(secret, id, ts, payload), 'base64');
    if (presented.some((p) => p.length === expected.length && timingSafeEqual(p, expected))) return;
  }
  throw new WebhookVerificationError('no matching signature');
}

/** Exponential backoff with full jitter, for BullMQ `backoff: { type: 'custom' }` strategies. Delay in ms. */
export function backoffWithJitter(attempt: number, baseMs = 5_000, capMs = 6 * 3_600_000, rand = Math.random): number {
  return Math.floor(rand() * Math.min(capMs, baseMs * 2 ** (attempt - 1)));
}
