import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { open, query } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { assertActive, bindSession, loadByToken, markViewed, needsVerification, recordLinkAccess, signCookieName, signingView } from "@/server/signing/service";

const Q = z.object({ locale: z.enum(["en", "fa"]).default("en") });

/**
 * Opening a signing link. Binds this browser to the request (cookie), records the access, and returns either the
 * verification step that must be completed first or the full signing view. Finished links return a read-only state.
 */
export const GET = open<{ token: string }>(async ({ req, ctx, params }) => {
  await rateLimit("signingOpen", ctx.ip ?? "unknown");
  const { locale } = query(req, Q);
  const l = await loadByToken(params.token, ctx);
  try { assertActive(l); } catch (e) {
    if (e instanceof AppError && (e.details as { code?: string } | undefined)?.code === "already_signed") {
      return { state: "signed", contract: { name: l.contract.name, reference: l.contract.reference, status: l.contract.status }, canDownload: l.contract.status === "COMPLETED" };
    }
    throw e;
  }
  const cookie = req.cookies.get(signCookieName(l.request.id))?.value;
  const bound = await bindSession(l, cookie, ctx);
  const fresh = bound.sessionValue === cookie ? l : await loadByToken(params.token, ctx);
  if (!cookie || bound.replaced || bound.sessionValue !== cookie) await recordLinkAccess(fresh, ctx);
  const need = needsVerification(fresh);
  let out: unknown;
  if (need !== "NONE") {
    out = { state: "verify", method: need, contract: { name: fresh.contract.name, reference: fresh.contract.reference }, recipient: { name: fresh.recipient.name, emailHint: fresh.recipient.email.replace(/^(.).*(@.*)$/, "$1•••$2") }, replaced: bound.replaced };
  } else {
    await markViewed(fresh, ctx);
    out = { state: "sign", ...(await signingView(fresh, locale)) };
  }
  const res = NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  res.cookies.set(signCookieName(l.request.id), bound.sessionValue, { httpOnly: true, sameSite: "strict", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: Math.max(60, Math.floor((l.request.expiresAt.getTime() - Date.now()) / 1000)) });
  return res;
});
