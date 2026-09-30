import { z } from "zod";
import { db } from "@/db";
import type { AuthContext } from "./auth/session";
import type { RequestContext } from "./audit";
import { AppError } from "./errors";
import type { Actor } from "./contracts/service";

export const actorOf = (auth: AuthContext, ctx: RequestContext): Actor => ({ orgId: auth.organisationId, userId: auth.user.id, ctx });
export const tx = <T>(fn: Parameters<typeof db.transaction<T>>[0]) => db.transaction(fn);
export const Uuid = z.string().uuid();
export function uuid(v: string, what = "Resource"): string {
  if (!Uuid.safeParse(v).success) throw new AppError("not_found", `${what} not found`);
  return v;
}

export const Pagination = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25) });

/** Sensitive admin actions (voiding, deleting, exporting audit data, changing security) need a recent re-authentication. */
export function requireElevation(auth: AuthContext) {
  if (!auth.elevated) throw new AppError("elevation_required", "Please confirm your identity to continue.", { code: "elevation_required", method: auth.user.hasTotp ? "totp" : "password" });
}
