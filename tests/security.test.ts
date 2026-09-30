import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { sha256 } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { createContract } from "@/server/contracts/service";
import { ctxFor, makeOrg } from "./helpers";
import * as contractRoute from "@/app/api/contracts/[id]/route";
import * as contractsRoute from "@/app/api/contracts/route";
import * as signRoute from "@/app/api/sign/[token]/route";
import * as signSubmit from "@/app/api/sign/[token]/submit/route";
import * as settingsRoute from "@/app/api/settings/route";

afterAll(stopBoss);

async function keyFor(orgId: string, userId: string, permissions: string[]) {
  const prefix = randomBytes(5).toString("hex");
  const secret = `bes_live_${prefix}_${randomBytes(24).toString("base64url")}`;
  await db.insert(schema.apiKeys).values({ organisationId: orgId, createdBy: userId, name: "test", prefix, keyHash: sha256(secret), permissions });
  return secret;
}

const req = (url: string, init: { method?: string; key?: string; json?: unknown; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers: { ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.json ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.json ? JSON.stringify(init.json) : undefined });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

async function twoTenants() {
  const A = await makeOrg("Tenant A"), B = await makeOrg("Tenant B");
  const contract = await db.transaction((tx) => createContract(tx, { orgId: A.org.id, userId: A.user.id, ctx: ctxFor() }, { name: "A secret deal", contractType: "nda" }));
  const keyA = await keyFor(A.org.id, A.user.id, ["contracts.view", "contracts.edit"]);
  const keyB = await keyFor(B.org.id, B.user.id, ["contracts.view", "contracts.edit", "contracts.delete", "contracts.create"]);
  return { A, B, contract, keyA, keyB };
}

describe("tenant isolation (IDOR)", () => {
  it("another organisation cannot read, edit or delete a contract by id", async () => {
    const { contract, keyB } = await twoTenants();
    const get = await contractRoute.GET(req(`/api/contracts/${contract.id}`, { key: keyB }), idCtx(contract.id));
    expect(get.status).toBe(404);
    expect(await get.text()).not.toContain("A secret deal");
    const patch = await contractRoute.PATCH(req(`/api/contracts/${contract.id}`, { method: "PATCH", key: keyB, json: { name: "hijacked" } }), idCtx(contract.id));
    expect(patch.status).toBe(404);
    const del = await contractRoute.DELETE(req(`/api/contracts/${contract.id}`, { method: "DELETE", key: keyB }), idCtx(contract.id));
    expect([403, 404]).toContain(del.status);
  });

  it("the owning organisation sees it, and the list never includes other tenants", async () => {
    const { contract, keyA, keyB } = await twoTenants();
    const ok = await contractRoute.GET(req(`/api/contracts/${contract.id}`, { key: keyA }), idCtx(contract.id));
    expect(ok.status).toBe(200);
    const list = await contractsRoute.GET(req("/api/contracts", { key: keyB }), { params: Promise.resolve({}) });
    expect(JSON.stringify(await list.json())).not.toContain(contract.id);
  });

  it("malformed ids are rejected as validation errors, not server errors", async () => {
    const { keyA } = await twoTenants();
    const r = await contractRoute.GET(req("/api/contracts/not-a-uuid", { key: keyA }), idCtx("not-a-uuid"));
    expect(r.status).toBeLessThan(500);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe("authentication and permission escalation", () => {
  it("rejects malformed and unknown API keys", async () => {
    const { contract } = await twoTenants();
    for (const key of ["garbage", "bes_live_deadbeef00_" + "x".repeat(30)]) {
      const r = await contractRoute.GET(req(`/api/contracts/${contract.id}`, key ? { key } : {}), idCtx(contract.id));
      expect(r.status).toBe(401);
    }
  });

  it("a key only carries the permissions it was issued with", async () => {
    const { A, contract } = await twoTenants();
    const viewOnly = await keyFor(A.org.id, A.user.id, ["contracts.view"]);
    expect((await contractRoute.GET(req(`/api/contracts/${contract.id}`, { key: viewOnly }), idCtx(contract.id))).status).toBe(200);
    expect((await contractRoute.PATCH(req(`/api/contracts/${contract.id}`, { method: "PATCH", key: viewOnly, json: { name: "x" } }), idCtx(contract.id))).status).toBe(403);
    expect((await settingsRoute.GET(req("/api/settings", { key: viewOnly }), { params: Promise.resolve({}) })).status).toBe(403);
  });

  it("a revoked key stops working", async () => {
    const { A, contract } = await twoTenants();
    const key = await keyFor(A.org.id, A.user.id, ["contracts.view"]);
    await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.keyHash, sha256(key)));
    expect((await contractRoute.GET(req(`/api/contracts/${contract.id}`, { key }), idCtx(contract.id))).status).toBe(401);
  });
});

describe("public signing endpoints", () => {
  it("unknown or guessed tokens get a generic client error and never a 500", async () => {
    for (const token of ["x", "A".repeat(43), randomBytes(32).toString("base64url")]) {
      const r = await signRoute.GET(req(`/api/sign/${token}`), { params: Promise.resolve({ token }) });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      const text = await r.text();
      expect(text).not.toMatch(/recipient|contract"?:/i);
    }
  });

  it("cross-site POSTs to signing endpoints are blocked before any work is done", async () => {
    const token = randomBytes(32).toString("base64url");
    const r = await signSubmit.POST(req(`/api/sign/${token}/submit`, { method: "POST", json: {}, headers: { origin: "https://evil.example" } }), { params: Promise.resolve({ token }) });
    expect(r.status).toBe(403);
  });
});
