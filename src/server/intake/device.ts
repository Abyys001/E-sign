import { createHash } from "node:crypto";
import { isIP } from "node:net";

/** Ordinary user-agent parsing. No canvas/audio/WebGL/font probing: this is operational visibility, not identity. */
export type Device = { browser: string; browserVersion: string | null; os: string; osVersion: string | null; deviceType: "desktop" | "mobile" | "tablet" | "unknown" };

const ver = (m: RegExpExecArray | null, i = 1) => (m?.[i] ? m[i]!.replace(/_/g, ".") : null);

export function parseUserAgent(ua: string | null | undefined): Device {
  const s = (ua ?? "").slice(0, 400);
  if (!s) return { browser: "Unknown", browserVersion: null, os: "Unknown", osVersion: null, deviceType: "unknown" };
  let browser = "Unknown", browserVersion: string | null = null;
  const tests: Array<[string, RegExp]> = [["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/], ["Opera", /OPR\/([\d.]+)/], ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/], ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/], ["Safari", /Version\/([\d.]+).*Safari/]];
  for (const [name, re] of tests) { const m = re.exec(s); if (m) { browser = name; browserVersion = m[1]!.split(".")[0]!; break; } }
  let os = "Unknown", osVersion: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /(?:iPhone|CPU) OS ([\d_]+)/.exec(s)) && /iPhone|iPad/.test(s)) { os = "iOS"; osVersion = ver(m); }
  else if ((m = /Android ([\d.]+)/.exec(s))) { os = "Android"; osVersion = ver(m); }
  else if ((m = /Windows NT ([\d.]+)/.exec(s))) { os = "Windows"; osVersion = m[1] === "10.0" ? "10/11" : ver(m); }
  else if ((m = /Mac OS X ([\d_.]+)/.exec(s))) { os = "macOS"; osVersion = ver(m); }
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Linux/.test(s)) os = "Linux";
  const deviceType: Device["deviceType"] = /iPad|Tablet|Android(?!.*Mobile)/.test(s) ? "tablet" : /Mobi|iPhone|Android.*Mobile/.test(s) ? "mobile" : os === "Unknown" ? "unknown" : "desktop";
  return { browser, browserVersion, os, osVersion, deviceType };
}

export const ipVersion = (ip: string | null | undefined): 4 | 6 | null => { const v = ip ? isIP(ip) : 0; return v === 4 ? 4 : v === 6 ? 6 : null; };

const clamp = (n: unknown, lo: number, hi: number) => (typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 100) / 100 : null);
const text = (s: unknown, max: number) => (typeof s === "string" && s.length ? s.slice(0, max) : null);

export type ClientInfo = { screenWidth: number | null; screenHeight: number | null; pixelRatio: number | null; language: string | null; timezone: string | null; platform: string | null };
/** Accepts only the small allow-list the client may report; everything else is dropped. */
export function sanitizeClientInfo(raw: unknown): ClientInfo {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tz = text(o.timezone, 64);
  return {
    screenWidth: clamp(o.screenWidth, 1, 20000), screenHeight: clamp(o.screenHeight, 1, 20000), pixelRatio: clamp(o.pixelRatio, 0.5, 10),
    language: text(o.language, 20), timezone: tz && /^[A-Za-z_+\-/0-9]+$/.test(tz) ? tz : null, platform: text(o.platform, 40),
  };
}

/** Coarse grouping key (browser+OS+type+screen+language+tz). Not a fingerprint: it deliberately carries little entropy. */
export const deviceKey = (d: Device, c: ClientInfo) =>
  createHash("sha256").update([d.browser, d.browserVersion ?? "", d.os, d.osVersion ?? "", d.deviceType, c.screenWidth ?? "", c.screenHeight ?? "", c.language ?? "", c.timezone ?? ""].join("|")).digest("hex").slice(0, 24);

export const describeDevice = (d: { browser: string | null; browserVersion: string | null; os: string | null; deviceType: string | null; screenWidth?: number | null; screenHeight?: number | null; timezone?: string | null }) =>
  [d.browser ? `${d.browser}${d.browserVersion ? ` ${d.browserVersion}` : ""}` : null, d.os, d.deviceType ? d.deviceType[0]!.toUpperCase() + d.deviceType.slice(1) : null, d.screenWidth && d.screenHeight ? `${d.screenWidth} × ${d.screenHeight}` : null, d.timezone].filter(Boolean).join(" · ");
