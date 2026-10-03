import type { NextRequest } from "next/server";
import { authed, type Handler } from "../http";
import type { Permission } from "../rbac";
import { getAcctSettings, ModeSchema, requireAccounting, type Mode } from "./core";

/** Mode from `?mode=test|live`, else the organisation's default. Test and live data are never combined in one response. */
export async function resolveMode(req: NextRequest, orgId: string): Promise<Mode> {
  const q = ModeSchema.safeParse(req.nextUrl.searchParams.get("mode"));
  return q.success ? q.data : (await getAcctSettings(orgId)).defaultMode;
}

type AcctHandler<P> = (a: Parameters<Handler<P>>[0] & { mode: Mode }) => ReturnType<Handler<P>>;

/** Accounting route: feature flag + session/API-key auth + permission + CSRF + rate limit (via `authed`) + resolved mode. */
export function acct<P = Record<string, never>>(perm: Permission, handler: AcctHandler<P>) {
  return authed<P>(perm, async (a) => {
    requireAccounting();
    return handler({ ...a, mode: await resolveMode(a.req, a.auth.organisationId) });
  });
}

export const csvResponse = (stream: ReadableStream<Uint8Array>, name: string) =>
  new Response(stream, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.csv"`, "cache-control": "private, no-store" } });
