import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory cookie jar standing in for next/headers (one "phone").
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), set: (n: string, v: string) => { jar.set(n, v); }, delete: (n: string) => { jar.delete(n); } }) }));

const { db, schema } = await import("@/db");
const { stopBoss } = await import("@/server/jobs");
const { env } = await import("@/lib/env");
const { createPairing, lockPhone, pairPhone, phoneStatus, pinProblem, requirePhone, revokePhoneDevice, unlockPhone, PHONE_SESSION_COOKIE, PHONE_DEVICE_COOKIE } = await import("@/server/accounting/phone");
const { makeOrg, ctxFor } = await import("./helpers");

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { await stopBoss(); });
beforeEach(() => { jar.clear(); });

const req = (h: Record<string, string> = { "x-bilit-phone": "1" }) => new NextRequest(`${env().APP_URL}/api/phone/call/tool`, { method: "POST", headers: h });
async function owner() {
  const { org, user } = await makeOrg("Phone Org");
  const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, user.id));
  const auth = { sessionId: "s", csrfToken: "c", user: { id: user.id, email: user.email, username: null, name: user.name, locale: "en", isSuperAdmin: false, hasTotp: false }, organisationId: org.id, membership: { roleKey: m!.roleKey, grants: m!.grants, denies: m!.denies }, elevated: true };
  return { org, user, auth };
}
const code = (url: string) => decodeURIComponent(/pair=([^&]+)/.exec(url)![1]!);

describe("Bilit Phone — PIN and QR pairing", () => {
  it("rejects weak PINs", () => {
    expect(pinProblem("123456")).toMatch(/sequence/);
    expect(pinProblem("987654")).toMatch(/sequence/);
    expect(pinProblem("111111")).toMatch(/repeated/);
    expect(pinProblem("12345")).toMatch(/6 digits/);
    expect(pinProblem("482915")).toBeNull();
  });

  it("pairs from a one-time QR code, unlocks with the PIN, locks again; the code works once", async () => {
    const { auth, user } = await owner();
    const p = await createPairing(auth, ctxFor());
    expect(p.svg).toContain("<svg");
    expect(p.url).toMatch(/\/phone#pair=/);
    await pairPhone(ctxFor(), { code: code(p.url), name: "iPhone", pin: "482915" });
    expect(await phoneStatus()).toMatchObject({ enrolled: true, unlocked: true, deviceName: "iPhone" });
    await expect(pairPhone(ctxFor(), { code: code(p.url), name: "x", pin: "482915" })).rejects.toThrow(/expired or was already used/);
    expect((await requirePhone(req(), ctxFor())).userId).toBe(user.id);
    await lockPhone();
    expect(await phoneStatus()).toMatchObject({ unlocked: false });
    await expect(requirePhone(req(), ctxFor())).rejects.toThrow(/locked/);
    await unlockPhone(ctxFor(), { pin: "482915" });
    expect(await phoneStatus()).toMatchObject({ unlocked: true });
    // only the newest code is valid
    const a = await createPairing(auth, ctxFor()), b = await createPairing(auth, ctxFor());
    jar.clear();
    await expect(pairPhone(ctxFor(), { code: code(a.url), name: "old", pin: "482915" })).rejects.toThrow(/expired/);
    await pairPhone(ctxFor(), { code: code(b.url), name: "new", pin: "482915" });
  });

  it("5 wrong PINs sign the phone out; the phone session is refused without the phone header", async () => {
    const { auth } = await owner();
    await pairPhone(ctxFor(), { code: code((await createPairing(auth, ctxFor())).url), name: "Android", pin: "482915" });
    await expect(requirePhone(req({}), ctxFor())).rejects.toThrow(/blocked/);
    await expect(requirePhone(req({ "x-bilit-phone": "1", origin: "https://evil.example" }), ctxFor())).rejects.toThrow(/Cross-site/);
    await lockPhone();
    for (let i = 1; i <= 4; i++) await expect(unlockPhone(ctxFor(), { pin: "000001" })).rejects.toThrow(new RegExp(`${5 - i} tr`));
    await expect(unlockPhone(ctxFor(), { pin: "000001" })).rejects.toThrow(/signed out/);
    expect(await phoneStatus()).toEqual({ enrolled: false });
    await expect(unlockPhone(ctxFor(), { pin: "482915" })).rejects.toThrow(/not set up/);
  });

  it("losing finance access, or signing the phone out in settings, stops the phone", async () => {
    const { auth, user, org } = await owner();
    const r = await pairPhone(ctxFor(), { code: code((await createPairing(auth, ctxFor())).url), name: "P", pin: "482915" });
    await revokePhoneDevice(auth, ctxFor(), r.id);
    await expect(requirePhone(req(), ctxFor())).rejects.toThrow(/locked|set up/);
    jar.clear();
    await pairPhone(ctxFor(), { code: code((await createPairing(auth, ctxFor())).url), name: "P2", pin: "482915" });
    await db.update(schema.memberships).set({ denies: ["accounting.view"] }).where(eq(schema.memberships.userId, user.id));
    await expect(requirePhone(req(), ctxFor())).rejects.toThrow(/no longer have access/);
    expect(jar.has(PHONE_DEVICE_COOKIE) && jar.has(PHONE_SESSION_COOKIE)).toBe(true);
    expect(await phoneStatus()).toEqual({ enrolled: false });
    void org;
  });
});
