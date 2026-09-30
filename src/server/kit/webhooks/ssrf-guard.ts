import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);
  return /^(fc|fd|fe[89ab])/.test(v6) || v6.startsWith('ff');
}

/**
 * Resolve, then reject private/link-local/loopback targets. Returns the address to connect to:
 * connect to THAT ip (with Host header/SNI preserved), otherwise DNS rebinding defeats the check.
 * Callers must also disable redirects.
 */
export async function assertPublicHttpsUrl(rawUrl: string): Promise<{ url: URL; address: string }> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('webhook endpoints must use https');
  if (url.username || url.password) throw new Error('credentials in URL not allowed');
  const records = await lookup(url.hostname, { all: true });
  if (records.length === 0) throw new Error('unresolvable host');
  if (records.some((r) => isBlockedAddress(r.address))) throw new Error('endpoint resolves to a non-public address');
  return { url, address: records[0]!.address };
}
