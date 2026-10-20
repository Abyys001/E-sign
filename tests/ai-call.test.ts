import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { getAiSettings, setAiChecker, updateAiSettings } from "@/server/accounting/ai";
import { CallSettings, CallToolInput, callTool, getCallSettings, setElevenApi, speakCall, updateCallSettings } from "@/server/accounting/ai-call";
import { DEFAULT_CALL_PROMPT } from "@/server/accounting/ai-call-prompt";
import { ACCOUNTANT_TOOL_NAMES, accountantCallSetup } from "@/server/accounting/ai-accountant";
import { ctxFor, makeOrg } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setAiChecker(null); setElevenApi(null); await stopBoss(); });

const spoken: Array<{ key: string; voiceId: string; model: string; text: string }> = [];
setElevenApi({
  voice: async (key, voiceId) => { if (!key.startsWith("sk_good")) throw new Error("bad key"); if (voiceId !== "Voice123") throw new Error("no voice"); return { name: "Rachel" }; },
  voices: async () => [{ id: "Voice123", name: "Rachel", category: "premade", labels: "british, calm" }],
  speak: async (key, a) => { spoken.push({ key, voiceId: a.voiceId, model: a.model, text: a.text }); return new Response("mp3"); },
});

async function seed() {
  const { org, user } = await makeOrg("Call Org");
  const actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  setAiChecker(async () => {});
  await updateAiSettings(actor, { enabled: true, model: "gpt-4.1", apiKey: "sk-test1234567890abcdefghijk", instructions: null });
  return actor;
}
const base = CallSettings.parse({});

describe("AI accountant voice call settings", () => {
  it("needs an ElevenLabs key and voice before calls can use ElevenLabs, and checks them", async () => {
    const a = await seed();
    await expect(updateCallSettings(a, { ...base, enabled: true })).rejects.toThrow(/ElevenLabs API key/);
    await expect(updateCallSettings(a, { ...base, enabled: true, elevenApiKey: "sk_good_0123456789abcdef" })).rejects.toThrow(/Choose an ElevenLabs voice/);
    await expect(updateCallSettings(a, { ...base, enabled: true, elevenVoiceId: "Voice123", elevenApiKey: "sk_bad_0123456789abcdefgh" })).rejects.toThrow(/bad key/);
    const r = await updateCallSettings(a, { ...base, enabled: true, elevenVoiceId: "Voice123", elevenApiKey: "sk_good_0123456789abcdef" });
    expect(r).toMatchObject({ hasElevenKey: true, elevenKeyHint: "sk_g…cdef", settings: { enabled: true, elevenVoiceName: "Rachel" } });
    expect(JSON.stringify(r)).not.toContain("sk_good_0123456789abcdef");
    // the key is stored encrypted
    const [row] = await db.select({ v: schema.acctSettings.aiSettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, a.orgId));
    expect(JSON.stringify(row!.v)).not.toContain("sk_good_0123456789abcdef");
  });

  it("saving the AI accountant card keeps the call settings and ElevenLabs key", async () => {
    const a = await seed();
    await updateCallSettings(a, { ...base, enabled: true, elevenVoiceId: "Voice123", elevenApiKey: "sk_good_0123456789abcdef", greeting: "Hello there" });
    await updateAiSettings(a, { enabled: true, model: "gpt-4.1", instructions: "x" });
    expect((await getAiSettings(a.orgId)).instructions).toBe("x");
    expect(await getCallSettings(a.orgId)).toMatchObject({ hasElevenKey: true, settings: { greeting: "Hello there", enabled: true } });
  });

  it("voices sentences with the saved voice; refuses while calls are off (except the settings test)", async () => {
    const a = await seed();
    await updateCallSettings(a, { ...base, enabled: false, elevenVoiceId: "Voice123", elevenApiKey: "sk_good_0123456789abcdef", elevenModel: "eleven_v3" });
    await expect(speakCall(a.orgId, "Hi")).rejects.toThrow(/switched off/);
    await speakCall(a.orgId, "Test", true);
    await updateCallSettings(a, { ...(await getCallSettings(a.orgId)).settings, enabled: true });
    await speakCall(a.orgId, "Cash is £28.00.");
    expect(spoken.slice(-2)).toEqual([{ key: "sk_good_0123456789abcdef", voiceId: "Voice123", model: "eleven_v3", text: "Test" }, { key: "sk_good_0123456789abcdef", voiceId: "Voice123", model: "eleven_v3", text: "Cash is £28.00." }]);
  });

  it("uses the behaviour prompt first and the finance rules after it; only read-only tools are callable", async () => {
    const a = await seed();
    const s = await accountantCallSetup(a, "test", DEFAULT_CALL_PROMPT);
    expect(s.instructions.startsWith("# MASTER SYSTEM PROMPT")).toBe(true);
    expect(s.instructions.indexOf("FINANCE RULES")).toBeGreaterThan(s.instructions.indexOf("Remain professional"));
    expect(s.instructions).toMatch(/You are read-only/);
    expect(s.tools.map((t) => t.name)).toEqual(ACCOUNTANT_TOOL_NAMES); // exactly the chat's read-only lookups
    expect(CallToolInput.safeParse({ name: "record_payment" }).success).toBe(false);
    await updateCallSettings(a, { ...base, voiceProvider: "openai", enabled: true });
    const r = await callTool(a, "test", { name: "calculate", arguments: JSON.stringify({ currency: "gbp", terms: [{ label: "a", amount: "1.10" }, { label: "b", amount: "2.20" }] }) });
    expect(JSON.parse(r.output).result).toBe("£3.30");
  });
});
