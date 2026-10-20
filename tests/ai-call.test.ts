import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { getAiSettings, setAiChecker, updateAiSettings } from "@/server/accounting/ai";
import { CallSettings, CallToolInput, callTool, getCallSettings, setElevenApi, speakCall, updateCallSettings } from "@/server/accounting/ai-call";
import { DEFAULT_CALL_PROMPT } from "@/server/accounting/ai-call-prompt";
import { spokenMoney } from "@/server/accounting/spoken-money";
import { callCards } from "@/server/accounting/ai-call-display";
import { ACCOUNTANT_TOOL_NAMES, accountantCallSetup } from "@/server/accounting/ai-accountant";
import { ctxFor, makeOrg } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setAiChecker(null); setElevenApi(null); await stopBoss(); });

const spoken: Array<{ key: string; voiceId: string; model: string; text: string }> = [];
setElevenApi({
  voice: async (key, voiceId) => { if (voiceId === "Missing7") return null; if (!key.startsWith("sk_good")) throw new Error("bad key"); if (voiceId === "Library9") return null; if (voiceId !== "Voice123") throw new Error("no voice"); return { name: "Rachel" }; },
  voices: async () => [{ id: "Voice123", name: "Rachel", category: "premade", labels: "british, calm" }],
  speak: async (key, a) => { if (a.voiceId === "Missing7") throw new Error("voice_not_found"); spoken.push({ key, voiceId: a.voiceId, model: a.model, text: a.text }); return new Response("mp3"); },
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

  it("accepts a Voice Library voice ElevenLabs can speak with, and explains how to add one it cannot", async () => {
    const a = await seed();
    const r = await updateCallSettings(a, { ...base, enabled: true, elevenVoiceId: "Library9", elevenApiKey: "sk_good_0123456789abcdef" });
    expect(r.settings.elevenVoiceName).toBe("Voice Library Library9");
    await expect(updateCallSettings(a, { ...base, enabled: true, elevenVoiceId: "Missing7" })).rejects.toThrow(/Add to my voices/);
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
    expect(spoken.slice(-2)).toEqual([{ key: "sk_good_0123456789abcdef", voiceId: "Voice123", model: "eleven_v3", text: "Test" }, { key: "sk_good_0123456789abcdef", voiceId: "Voice123", model: "eleven_v3", text: "Cash is 28 pounds." }]); // amounts are spoken in words
  });

  it("voices Persian sentences with the Persian voice and model, English with the English ones", async () => {
    const a = await seed();
    await updateCallSettings(a, { ...base, enabled: true, elevenVoiceId: "Voice123", elevenVoiceIdFa: "Library9", elevenModel: "eleven_flash_v2_5", elevenModelFa: "eleven_v3", elevenApiKey: "sk_good_0123456789abcdef" });
    await speakCall(a.orgId, "موجودی نقدی ۲۸ پوند است.");
    await speakCall(a.orgId, "Cash is £28.00.");
    expect(spoken.slice(-2).map((x) => [x.voiceId, x.model])).toEqual([["Library9", "eleven_v3"], ["Voice123", "eleven_flash_v2_5"]]);
    // no Persian voice set → the English voice, still with the Persian model
    await updateCallSettings(a, { ...(await getCallSettings(a.orgId)).settings, elevenVoiceIdFa: "" });
    await speakCall(a.orgId, "سلام");
    expect(spoken.at(-1)).toMatchObject({ voiceId: "Voice123", model: "eleven_v3" });
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
    // the screen gets the same verified figure
    expect(r.cards).toEqual([{ kind: "summary", title: "Calculation", highlight: { label: "Result", value: "£3.30" }, rows: [{ label: "a", value: "£1.10" }, { label: "b", value: "£2.20" }] }]);
  });
});

describe("voice call — currency spoken exactly as written, screen cards from verified figures", () => {
  it("never reads euros as pounds; decimals as cents/pence; Persian currency names", () => {
    expect(spokenMoney("Epic Wave is owed €9,808.18 and was paid €25,000.00.", "en")).toBe("Epic Wave is owed 9,808 euros and 18 cents and was paid 25,000 euros.");
    expect(spokenMoney("Ticket £45.00, fee £1.05, refund -£0.50", "en")).toBe("Ticket 45 pounds, fee 1 pound and 5 pence, refund minus 50 pence");
    expect(spokenMoney("US$120.00 · SEK 1,500.00 · 1,500.00 EUR", "en")).toBe("120 US dollars · 1,500 Swedish kronor · 1,500 euros");
    expect(spokenMoney("مانده €9,808.18 و £45.00", "fa")).toBe("مانده ۹٬۸۰۸ یورو و ۱۸ سنت و ۴۵ پوند");
    expect(spokenMoney("Event B41-0091 had 1,234 tickets in 2026.", "en")).toBe("Event B41-0091 had 1,234 tickets in 2026.");
  });

  it("gives every event its own titled card with the figures exactly as the lookup returned them", () => {
    const out = { period: { from: null, to: null }, count: 2, totalsPerCurrency: [{ currency: "eur", gross: "€2,000.00", bilitRevenue: "€200.00", contributionProfit: "€150.00", organiserRemaining: "€900.00" }],
      events: [{ code: "B41-0084", name: "Hamburg Night", date: "2026-10-25", status: "ACTIVE", organiser: "Epic Wave", currency: "eur", gross: "€1,500.00", organiserRemaining: "€700.00", organiserDue: "€1,200.00", organiserPaid: "€500.00", contributionProfit: "€100.00", link: "/accounting/events/x" },
        { code: "B41-0082", name: "Chamber Orchestra", date: "2026-09-01", organiser: "Epic Wave", currency: "eur", gross: "€500.00", organiserRemaining: "€200.00", contributionProfit: "€50.00" }] };
    const cards = callCards("events_breakdown", out);
    expect(cards.map((c) => c.title)).toEqual(["Hamburg Night", "Chamber Orchestra", "All 2 events — EUR"]);
    expect(cards[0]).toMatchObject({ kind: "event", subtitle: "B41-0084", meta: ["25 Oct 2026", "Epic Wave", "ACTIVE"], highlight: { label: "Still owed to organiser", value: "€700.00" } });
    expect(cards[0]!.rows).toContainEqual({ label: "Ticket sales (gross)", value: "€1,500.00", strong: true });
    expect(callCards("events_breakdown", { error: "x" })).toEqual([]);
  });
});
