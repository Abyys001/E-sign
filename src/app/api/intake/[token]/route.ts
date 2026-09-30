import { NextResponse } from "next/server";
import { open } from "@/server/http";
import { openForm } from "@/server/intake/public";
import { cookieOf, withCookie } from "../cookie";

/** Opening the link records access immediately (before any answer exists) and returns only what this session needs to render. */
export const GET = open<{ token: string }>(async ({ req, ctx, params }) => {
  const { view, cookie } = await openForm(params.token, cookieOf(req, params.token), ctx);
  return withCookie(NextResponse.json(view, { headers: { "cache-control": "no-store" } }), req, cookie);
});
