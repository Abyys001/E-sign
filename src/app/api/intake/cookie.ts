import { NextResponse, type NextRequest } from "next/server";
import { intakeCookieName, type CookieOut } from "@/server/intake/public";

export const cookieOf = (req: NextRequest, token: string) => req.cookies.get(intakeCookieName(token))?.value;
export function withCookie(res: NextResponse, req: NextRequest, c: CookieOut | null) {
  if (c) res.cookies.set(c.name, c.value, { httpOnly: true, sameSite: "strict", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: c.maxAgeSeconds });
  return res;
}
