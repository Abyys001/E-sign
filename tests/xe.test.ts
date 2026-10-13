import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { getAcctSettings } from "@/server/accounting/core";
import { getXeSettings, invertRates, setXeFetch, updateXeSettings, xeRates, XeSettingsInput } from "@/server/accounting/xe";
import { ctxFor, makeOrg } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setXeFetch(null); await stopBoss(); });

describe("XE rates — pure helpers", () => {
  it("inverts XE's '1 TARGET = mid SOURCE' into '1 SOURCE = rate TARGET', skipping the target and bad quotes", () => {
    expect(invertRates("gbp", [{ quotecurrency: "EUR", mid: 1.25 }, { quotecurrency: "GBP", mid: 1 }, { quotecurrency: "SEK", mid: 0 }])).toEqual({ eur: "0.80000000" });
  });
  it("cleans pasted keys and rejects odd account IDs", () => {
    expect(XeSettingsInput.parse({ accountId: "bilit123", apiKey: ' "abcd efgh12"\n' }).apiKey).toBe("abcdefgh12");
    expect(XeSettingsInput.safeParse({ accountId: "bad id!" }).success).toBe(false);
  });
});

describe("XE rates — connection", () => {
  let actor: { orgId: string; userId: string; ctx: ReturnType<typeof ctxFor> };
  let calls: Array<{ accountId: string; apiKey: string; target: string; sources: string[] }>;
  beforeAll(async () => {
    const { org, user } = await makeOrg("XE Test");
    actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
    await getAcctSettings(org.id);
    await db.update(schema.acctSettings).set({ reportingCurrency: "gbp" }).where(eq(schema.acctSettings.organisationId, org.id));
    calls = [];
    setXeFetch(async (a) => {
      calls.push(a);
      return { timestamp: "2026-10-13T16:00:00Z", quotes: a.sources.map((s) => ({ quotecurrency: s.toUpperCase(), mid: s === "eur" ? 1.15 : 14.5 })) };
    });
  });

  it("is off until connected, checks the key on save and never returns it", async () => {
    expect(await xeRates(actor.orgId, "gbp", ["eur"])).toBeNull();
    const s = await updateXeSettings(actor, { accountId: "bilit123", apiKey: "secretkey123" });
    expect(calls[0]).toMatchObject({ accountId: "bilit123", apiKey: "secretkey123", target: "gbp", sources: ["eur"] });
    expect(s).toMatchObject({ connected: true, accountId: "bilit123", keyHint: "sec…123", lastError: null });
    expect(JSON.stringify(s)).not.toContain("secretkey123");
  });

  it("returns live rates, caches them, and falls back to the last good set marked stale", async () => {
    const r = await xeRates(actor.orgId, "gbp", ["eur", "sek", "gbp"]);
    expect(r).toMatchObject({ source: "XE mid-market rate", rates: { eur: (1 / 1.15).toFixed(8), sek: (1 / 14.5).toFixed(8) } });
    const n = calls.length;
    await xeRates(actor.orgId, "gbp", ["sek", "eur"]);
    expect(calls.length).toBe(n); // cached
    setXeFetch(async () => { throw new Error("XE down"); }); // also clears the cache
    const stale = await xeRates(actor.orgId, "gbp", ["eur", "sek"]);
    expect(stale).toMatchObject({ stale: true, source: "XE mid-market rate (last known)", rates: { eur: (1 / 1.15).toFixed(8) } });
    expect((await getXeSettings(actor.orgId)).lastError).toMatch(/XE down/);
    expect(await xeRates(actor.orgId, "gbp", ["eur", "usd"])).toBeNull(); // no last-known USD rate
  });

  it("disconnecting removes the key and the stored rates", async () => {
    const s = await updateXeSettings(actor, { accountId: null, apiKey: null });
    expect(s).toMatchObject({ connected: false, keyHint: null, lastRates: {} });
    expect(await xeRates(actor.orgId, "gbp", ["eur"])).toBeNull();
  });
});
