import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError } from "./errors";
import { log } from "./logger";
import { checkCsrf, requireAuth, type AuthContext } from "./auth/session";
import { apiKeyAuth } from "./auth/api-key";
import type { RequestContext } from "./audit";
import type { Permission } from "./rbac";
import { rateLimit } from "./rate-limit";

/**
 * Client IP. X-Forwarded-For is client-controlled at its left; only the entries appended by OUR proxies (the right-most
 * TRUSTED_PROXY_HOPS) can be trusted. With N trusted hops the client address is the Nth entry from the right.
 * With 0 hops forwarding headers are ignored altogether.
 */
export function clientIp(req: NextRequest): string {
  const hops = env().TRUSTED_PROXY_HOPS;
  if (hops === 0) return "unknown";
  const xff = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const ip = xff.length >= hops ? xff[xff.length - hops] : undefined;
  return ip && ip.length <= 45 ? ip : req.headers.get("x-real-ip")?.slice(0, 45) || "unknown";
}

export function deviceInfo(ua: string | null) {
  const s = ua ?? "";
  const os = /iPhone|iPad|iOS/.test(s) ? "iOS" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Linux/.test(s) ? "Linux" : "Unknown";
  const browser = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "Unknown";
  const type = /Mobi|iPhone|Android.*Mobile/.test(s) ? "mobile" : /iPad|Tablet|Android/.test(s) ? "tablet" : "desktop";
  return { os, browser, type };
}

export function requestContext(req: NextRequest, correlationId: string): RequestContext {
  const ua = req.headers.get("user-agent");
  return { ip: clientIp(req), userAgent: ua?.slice(0, 300) ?? null, correlationId, device: deviceInfo(ua) };
}

export type Handler<P> = (a: { req: NextRequest; ctx: RequestContext; params: P; auth: AuthContext; correlationId: string }) => Promise<Response | unknown>;
export type PublicHandler<P> = (a: { req: NextRequest; ctx: RequestContext; params: P; correlationId: string }) => Promise<Response | unknown>;

type RouteCtx<P> = { params: Promise<P> };

function errorResponse(e: unknown, correlationId: string, req: NextRequest) {
  if (e instanceof ZodError) {
    return NextResponse.json({ error: { code: "validation_failed", message: "Some fields are invalid.", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })), correlationId } }, { status: 422, headers: { "x-correlation-id": correlationId } });
  }
  if (e instanceof AppError) {
    if (e.status >= 500 || e.code === "forbidden" || e.code === "unauthenticated") log.warn("api.denied", { correlationId, code: e.code, path: req.nextUrl.pathname });
    return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details, correlationId } }, { status: e.status, headers: { "x-correlation-id": correlationId, ...e.headers } });
  }
  log.error("api.unhandled", { correlationId, path: req.nextUrl.pathname, err: e });
  return NextResponse.json({ error: { code: "internal", message: "Something went wrong on our side. Please try again.", correlationId } }, { status: 500, headers: { "x-correlation-id": correlationId } });
}

function finish(out: unknown, correlationId: string) {
  if (out instanceof Response) { out.headers.set("x-correlation-id", correlationId); return out; }
  return NextResponse.json(out ?? { ok: true }, { headers: { "x-correlation-id": correlationId } });
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Authenticated route: session + permission + CSRF (mutations) + API rate limit, with uniform error shape and correlation id. */
export function authed<P = Record<string, never>>(perm: Permission | null, handler: Handler<P>) {
  return async (req: NextRequest, route: RouteCtx<P>) => {
    const correlationId = req.headers.get("x-correlation-id")?.slice(0, 64) || randomUUID();
    try {
      const bearer = req.headers.get("authorization");
      // Bearer API keys are not ambient credentials, so CSRF does not apply to them; browser sessions always need the CSRF token.
      const auth = bearer?.startsWith("Bearer ") ? await apiKeyAuth(bearer.slice(7), perm) : await requireAuth(perm ?? undefined);
      if (!bearer && MUTATING.has(req.method)) checkCsrf(auth, req.headers.get("x-csrf-token"), req.headers.get("origin"));
      await rateLimit("api", auth.user.id);
      const out = await handler({ req, ctx: requestContext(req, correlationId), params: await route.params, auth, correlationId });
      return finish(out, correlationId);
    } catch (e) { return errorResponse(e, correlationId, req); }
  };
}

/** Unauthenticated route (signing links, login, verification). Callers enforce their own auth + rate limits. */
export function open<P = Record<string, never>>(handler: PublicHandler<P>) {
  return async (req: NextRequest, route: RouteCtx<P>) => {
    const correlationId = req.headers.get("x-correlation-id")?.slice(0, 64) || randomUUID();
    try {
      if (MUTATING.has(req.method)) {
        const origin = req.headers.get("origin");
        // Compare against APP_URL: behind a reverse proxy req.nextUrl.origin is the internal listen address, not the public origin.
        if (origin && new URL(origin).origin !== new URL(env().APP_URL).origin) throw new AppError("forbidden", "Cross-site request blocked.");
      }
      const out = await handler({ req, ctx: requestContext(req, correlationId), params: await route.params, correlationId });
      return finish(out, correlationId);
    } catch (e) { return errorResponse(e, correlationId, req); }
  };
}

export async function body<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  const text = await req.text();
  if (text.length > 1_000_000) throw new AppError("payload_too_large", "Request is too large.");
  let json: unknown;
  try { json = text ? JSON.parse(text) : {}; } catch { throw new AppError("bad_request", "Request body must be valid JSON."); }
  return schema.parse(json);
}

export function query<T>(req: NextRequest, schema: ZodType<T>): T {
  return schema.parse(Object.fromEntries(req.nextUrl.searchParams));
}
