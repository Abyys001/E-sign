import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { sha256 } from "@/server/crypto";
import { body, open } from "@/server/http";
import { sendUserToken } from "@/server/orgs";
import { rateLimit } from "@/server/rate-limit";

/** Always answers the same way so the endpoint cannot be used to discover which emails have accounts. */
export const POST = open(async ({ req, ctx }) => {
  // Accepts an email or a username; the link always goes to the account's email address.
  const { email } = await body(req, z.object({ email: z.string().trim().min(1).max(254) }));
  const e = email.toLowerCase();
  await rateLimit("login", `forgot:${ctx.ip}`);
  await rateLimit("loginEmail", `forgot:${sha256(e)}`);
  const [u] = await db.select().from(schema.users).where(e.includes("@") ? eq(schema.users.email, e) : sql`lower(${schema.users.username}) = ${e}`);
  if (u && !u.deletedAt) {
    const [m] = await db.select({ orgId: schema.memberships.organisationId }).from(schema.memberships).where(eq(schema.memberships.userId, u.id)).limit(1);
    if (m) await db.transaction((tx) => sendUserToken(tx, m.orgId, u, "PASSWORD_RESET", "Bilit.event E-Sign"));
  }
  return { ok: true };
});
