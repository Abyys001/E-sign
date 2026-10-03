import type { MatchRule } from "./core";

/** Event codes: 2–64 chars, letters/digits plus . _ - (e.g. EVT-BER-2026-001). Compared case-insensitively. */
export const EVENT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
export const normCode = (c: string) => c.trim().toUpperCase();

export type CodeSource = { description?: string | null; metadata?: Record<string, unknown> | null; paymentIntentDescription?: string | null; paymentIntentMetadata?: Record<string, unknown> | null };

export type Extraction =
  | { ok: true; code: string; method: MatchRule["type"]; known: boolean }
  | { ok: false; reason: "NO_CODE" | "AMBIGUOUS" | "CODE_NOT_FOUND"; method?: MatchRule["type"]; code?: string; candidates?: string[] };

const TOKEN = /[A-Za-z0-9][A-Za-z0-9_.-]*/g;
const tokens = (s: string) => [...s.slice(0, 2000).matchAll(TOKEN)].map((m) => m[0].replace(/[.\-_]+$/, "")).filter((t) => t.length >= 2);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const meta = (m: Record<string, unknown> | null | undefined, key: string) => {
  if (!m) return undefined;
  const hit = Object.entries(m).find(([k]) => k.toLowerCase() === key.toLowerCase());
  return typeof hit?.[1] === "string" && hit[1].trim() ? hit[1].trim() : undefined;
};

/**
 * Extract an event code from Stripe data using the configured rules, in order. The first rule that yields a code which
 * exists in Bilit wins. A rule that yields several different known codes stops matching as AMBIGUOUS (never guessed).
 * If no rule resolves, the first code that was found but is unknown is reported as CODE_NOT_FOUND.
 */
export function extractEventCode(src: CodeSource, rules: MatchRule[], knownCodes: ReadonlySet<string>): Extraction {
  const descs = [src.description, src.paymentIntentDescription].filter((d): d is string => !!d && !!d.trim());
  let firstUnknown: { code: string; method: MatchRule["type"] } | undefined;
  for (const r of rules) {
    let found: string[] = [];
    if (r.type === "METADATA") {
      const v = meta(src.metadata, r.key) ?? meta(src.paymentIntentMetadata, r.key);
      if (v) found = [v];
    } else if (r.type === "EXACT") {
      found = descs.flatMap(tokens).filter((t) => knownCodes.has(normCode(t)));
    } else if (r.type === "PREFIX") {
      const re = new RegExp(`(?:^|[^A-Za-z0-9_.-])(${escapeRe(r.prefix)}[A-Za-z0-9_.-]*[A-Za-z0-9])`, "gi");
      found = descs.flatMap((d) => [...d.slice(0, 2000).matchAll(re)].map((m) => m[1]!));
    } else {
      const re = new RegExp(r.pattern, "g");
      found = descs.flatMap((d) => [...d.slice(0, 2000).matchAll(re)].map((m) => m[1] ?? m[0]).filter(Boolean));
    }
    const uniq = [...new Set(found.map(normCode))].filter((c) => EVENT_CODE_RE.test(c));
    if (!uniq.length) continue;
    const known = uniq.filter((c) => knownCodes.has(c));
    if (known.length > 1) return { ok: false, reason: "AMBIGUOUS", method: r.type, candidates: known };
    if (known.length === 1) return { ok: true, code: known[0]!, method: r.type, known: true };
    if (uniq.length > 1 && r.type !== "EXACT") return { ok: false, reason: "AMBIGUOUS", method: r.type, candidates: uniq };
    firstUnknown ??= { code: uniq[0]!, method: r.type };
  }
  return firstUnknown ? { ok: false, reason: "CODE_NOT_FOUND", method: firstUnknown.method, code: firstUnknown.code } : { ok: false, reason: "NO_CODE" };
}

/** Ticket count for per-ticket commission: a positive integer in the configured metadata key, else 1 (one charge = one ticket). */
export function ticketQuantity(metadata: Record<string, unknown> | null | undefined, piMetadata: Record<string, unknown> | null | undefined, key: string): number {
  const v = meta(metadata, key) ?? meta(piMetadata, key);
  const n = v && /^\d{1,5}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
