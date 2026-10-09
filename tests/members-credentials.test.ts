import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { verifyPassword } from "@/server/auth/password";
import { createMemberWithPassword, setMemberCredentials, usernameProblem } from "@/server/orgs";
import { ctxFor, makeOrg } from "./helpers";

const uniq = () => Math.random().toString(36).slice(2, 10);
const PW = "correct horse battery";

describe("usernames", () => {
  it("validates format and never allows @", () => {
    expect(usernameProblem("jo.smith-2")).toBeNull();
    expect(usernameProblem("Jo_Smith")).toBeNull(); // stored lower-case
    expect(usernameProblem("ab")).not.toBeNull();
    expect(usernameProblem("a@b.com")).not.toBeNull();
    expect(usernameProblem(".dot")).not.toBeNull();
    expect(usernameProblem("has space")).not.toBeNull();
  });
});

describe("admin-managed sign-in details", () => {
  const actorOf = (userId: string, roleKey = "ORG_OWNER") => ({ id: userId, roleKey, isSuperAdmin: false, sessionId: "00000000-0000-0000-0000-000000000000" });

  it("creates a member with a username and password that verify", async () => {
    const { org, user } = await makeOrg();
    const username = `Jo.${uniq()}`;
    const u = await db.transaction((tx) => createMemberWithPassword(tx, org.id, user.id, { email: `${uniq()}@example.test`, name: "Jo", username, password: PW, roleKey: "SENDER" }, ctxFor()));
    expect(u.username).toBe(username.toLowerCase());
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(await verifyPassword(row!.passwordHash, PW)).toBe(true);
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, u.id));
    expect(m).toMatchObject({ organisationId: org.id, roleKey: "SENDER" });
  });

  it("rejects duplicate usernames (case-insensitive), existing emails and weak passwords", async () => {
    const { org, user } = await makeOrg();
    const username = `dup${uniq()}`;
    await db.transaction((tx) => createMemberWithPassword(tx, org.id, user.id, { email: `${uniq()}@example.test`, name: "A", username, password: PW, roleKey: "SENDER" }, ctxFor()));
    await expect(db.transaction((tx) => createMemberWithPassword(tx, org.id, user.id, { email: `${uniq()}@example.test`, name: "B", username: username.toUpperCase(), password: PW, roleKey: "SENDER" }, ctxFor()))).rejects.toThrow(/taken/);
    await expect(db.transaction((tx) => createMemberWithPassword(tx, org.id, user.id, { email: user.email, name: "C", username: `x${uniq()}`, password: PW, roleKey: "SENDER" }, ctxFor()))).rejects.toThrow(/already has an account/);
    await expect(db.transaction((tx) => createMemberWithPassword(tx, org.id, user.id, { email: `${uniq()}@example.test`, name: "D", username: `y${uniq()}`, password: "short", roleKey: "SENDER" }, ctxFor()))).rejects.toThrow(/12 characters/);
  });

  it("sets a new password: unlocks, signs out, burns reset links; clears username", async () => {
    const { org, user } = await makeOrg();
    const u = await db.transaction((tx) => createMemberWithPassword(tx, org.id, user.id, { email: `${uniq()}@example.test`, name: "E", username: `e${uniq()}`, password: PW, roleKey: "SENDER" }, ctxFor()));
    await db.update(schema.users).set({ failedLogins: 9, lockedUntil: new Date(Date.now() + 600_000) }).where(eq(schema.users.id, u.id));
    await db.insert(schema.userTokens).values({ userId: u.id, organisationId: org.id, purpose: "PASSWORD_RESET", tokenHash: `h-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000) });
    await db.insert(schema.sessions).values({ userId: u.id, activeOrganisationId: org.id, tokenHash: `s-${uniq()}`, csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000) });

    await db.transaction((tx) => setMemberCredentials(tx, org.id, actorOf(user.id), u.id, { password: "a brand new password" }, ctxFor()));
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(await verifyPassword(row!.passwordHash, "a brand new password")).toBe(true);
    expect(row).toMatchObject({ failedLogins: 0, lockedUntil: null });
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, u.id))).toHaveLength(0);
    expect((await db.select().from(schema.userTokens).where(eq(schema.userTokens.userId, u.id))).every((t) => t.usedAt)).toBe(true);

    const r = await db.transaction((tx) => setMemberCredentials(tx, org.id, actorOf(user.id), u.id, { username: null }, ctxFor()));
    expect(r.username).toBeNull();
  });

  it("refuses accounts shared with another org, and owners unless the actor is an owner", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const shared = await db.transaction((tx) => createMemberWithPassword(tx, a.org.id, a.user.id, { email: `${uniq()}@example.test`, name: "S", username: `s${uniq()}`, password: PW, roleKey: "SENDER" }, ctxFor()));
    await db.insert(schema.memberships).values({ organisationId: b.org.id, userId: shared.id, roleKey: "SENDER" });
    await expect(db.transaction((tx) => setMemberCredentials(tx, a.org.id, actorOf(a.user.id), shared.id, { password: "taken over password" }, ctxFor()))).rejects.toThrow(/another organisation/);

    const owner = await db.transaction((tx) => createMemberWithPassword(tx, a.org.id, a.user.id, { email: `${uniq()}@example.test`, name: "O", username: `o${uniq()}`, password: PW, roleKey: "ORG_OWNER" }, ctxFor()));
    await expect(db.transaction((tx) => setMemberCredentials(tx, a.org.id, actorOf(a.user.id, "ADMIN"), owner.id, { password: "taken over password" }, ctxFor()))).rejects.toThrow(/Only an owner/);
    await expect(db.transaction((tx) => setMemberCredentials(tx, b.org.id, actorOf(b.user.id), owner.id, { password: "taken over password" }, ctxFor()))).rejects.toThrow(/not found/i);
  });
});
