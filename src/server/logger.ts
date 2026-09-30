type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;
const REDACT = /pass|secret|token|authorization|cookie|otp|code|key/i;

/** Signing/intake links are bearer secrets. They must not survive in URLs that end up inside error messages or request logs. */
export const redactUrlSecrets = (s: string) => s
  .replace(/(\/(?:s|intake|sign|api\/sign|api\/intake)\/)[A-Za-z0-9_-]{20,}/g, "$1[redacted]")
  .replace(/([?&](?:token|code|key|secret)=)[^&\s"']+/gi, "$1[redacted]");

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4 || v == null) return v;
  if (typeof v === "string") return redactUrlSecrets(v);
  if (v instanceof Error) return { name: v.name, message: redactUrlSecrets(v.message), stack: process.env.NODE_ENV === "production" ? undefined : v.stack && redactUrlSecrets(v.stack) };
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, REDACT.test(k) ? "[redacted]" : scrub(x, depth + 1)]));
  return v;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(scrub(fields) as object) });
  (level === "error" ? console.error : console.log)(line);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
  /** Security-relevant events get a stable channel so they can be alerted on. */
  security: (event: string, f?: Record<string, unknown>) => emit("warn", `security.${event}`, { channel: "security", ...f }),
};
