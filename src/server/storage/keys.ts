import { randomUUID } from "node:crypto";

/** Object keys are server-generated only; client filenames never reach the storage layer. */
export function objectKey(orgId: string, area: "source" | "final" | "certificate" | "signature" | "template" | "branding" | "export" | "intake"): string {
  return `orgs/${orgId}/${area}/${randomUUID()}`;
}

const SAFE = /^orgs\/[0-9a-f-]{36}\/(source|final|certificate|signature|template|branding|export|intake)\/[0-9a-f-]{36}$/;
export const isSafeKey = (k: string) => SAFE.test(k);

export function safeDownloadName(name: string, ext: string): string {
  const base = name.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").slice(0, 80) || "document";
  return `${base}.${ext}`;
}
