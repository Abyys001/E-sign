"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public correlationId?: string) { super(message); }
}

const csrf = () => (typeof document === "undefined" ? "" : document.cookie.split("; ").find((c) => c.startsWith("bes_csrf="))?.slice(9) ?? "");

type Opts = { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal; idempotencyKey?: string };

/** Single fetch wrapper: CSRF header on mutations, uniform error shape, JSON or empty responses. */
export async function api<T = unknown>(path: string, o: Opts = {}): Promise<T> {
  const method = o.method ?? (o.json !== undefined || o.form ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-csrf-token"] = csrf();
  if (o.json !== undefined) headers["content-type"] = "application/json";
  if (o.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
  const res = await fetch(path, { method, headers, body: o.form ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined), signal: o.signal, credentials: "same-origin" });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown; correlationId?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`, e?.details, e?.correlationId);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong.");

/** Minimal data hook: loads on mount and whenever `key` changes; `reload` refetches; stale responses are ignored. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try { const d = await api<T>(path); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, "network", "Network error")); }
    finally { if (n === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export const fmtDate = (d: string | Date | null | undefined, locale: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) =>
  d ? new Intl.DateTimeFormat(locale === "fa" ? "fa-IR-u-ca-persian" : "en-GB", opts).format(new Date(d)) : "—";
export const fmtNum = (n: number, locale: string) => new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-GB").format(n);
