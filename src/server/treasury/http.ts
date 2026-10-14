import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { clientIp, requestContext } from "../http";
import { rateLimit } from "../rate-limit";
import { AppError } from "../errors";
import { log } from "../logger";
import { ZodError } from "zod";
import { assertStaffCsrf, currentStaff, type StaffContext } from "./auth";

type StaffHandler<P> = (a: { req: NextRequest; sc: StaffContext; params: P; correlationId: string }) => Promise<Response | unknown>;
type RouteCtx<P> = { params: Promise<P> };
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function err(e: unknown, correlationId: string, path: string) {
  if (e instanceof ZodError) return NextResponse.json({ error: { code: "validation_failed", message: "Some fields are invalid.", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })), correlationId } }, { status: 422 });
  if (e instanceof AppError) { if (e.code === "forbidden" || e.code === "unauthenticated") log.warn("treasury.denied", { correlationId, code: e.code, path }); return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details, correlationId } }, { status: e.status }); }
  log.error("treasury.unhandled", { correlationId, path, err: e });
  return NextResponse.json({ error: { code: "internal", message: "Something went wrong. Please try again.", correlationId } }, { status: 500 });
}
const finish = (out: unknown) => (out instanceof Response ? out : NextResponse.json(out ?? { ok: true }));

/** Authenticated staff route: resolve the staff session, enforce CSRF on mutations, and rate-limit. No org/Stripe auth. */
export function staffRoute<P = Record<string, never>>(handler: StaffHandler<P>) {
  return async (req: NextRequest, route: RouteCtx<P>) => {
    const correlationId = req.headers.get("x-correlation-id")?.slice(0, 64) || randomUUID();
    try {
      const sc = await currentStaff(requestContext(req, correlationId));
      if (!sc) throw new AppError("unauthenticated", "Please sign in.");
      if (MUTATING.has(req.method)) {
        // the header must match the token stored with the server-side session (the cookie only lets the page read it)
        assertStaffCsrf(req.headers.get("x-csrf-token"), sc.csrf);
      }
      await rateLimit("treasuryStaff", sc.staff.id);
      return finish(await handler({ req, sc, params: await route.params, correlationId }));
    } catch (e) { return err(e, correlationId, req.nextUrl.pathname); }
  };
}

/** Public staff route (login, accept-invite): no session required; the handler enforces its own rate limits. */
export function staffPublic<P = Record<string, never>>(handler: (a: { req: NextRequest; ip: string; params: P; correlationId: string }) => Promise<Response | unknown>) {
  return async (req: NextRequest, route: RouteCtx<P>) => {
    const correlationId = req.headers.get("x-correlation-id")?.slice(0, 64) || randomUUID();
    try { return finish(await handler({ req, ip: clientIp(req), params: await route.params, correlationId })); }
    catch (e) { return err(e, correlationId, req.nextUrl.pathname); }
  };
}
