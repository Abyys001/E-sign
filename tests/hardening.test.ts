import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { ctxFor, makeOrg } from "./helpers";
import { LEGAL_MATRIX, matrixStats } from "@/server/legal/matrix";
import { redactUrlSecrets } from "@/server/logger";
import { queueEmail, deliverEmail } from "@/server/messaging/email";
import { recordEmailEvent } from "@/server/messaging/events";
import { openForm } from "@/server/intake/public";
import { scanIntakeReminders } from "@/server/intake/tasks";
import { createAgreementTemplate, publishAgreementVersion } from "@/server/agreements/service";
import { createIntakeForm, publishFormVersion } from "@/server/intake/forms";
import { sendInvitation } from "@/server/intake/invitations";

afterAll(stopBoss);
process.env.SMTP_HOST = "127.0.0.1";

const req = (h: Record<string, string>) => new NextRequest("http://localhost/x", { headers: h });
async function ipWith(hops: string, h: Record<string, string>) {
  vi.resetModules();
  process.env.TRUSTED_PROXY_HOPS = hops;
  const { clientIp } = await import("@/server/http");
  return clientIp(req(h));
}

describe("trusted proxy IP handling", () => {
  it("takes the Nth entry from the right, so a client-supplied leading entry cannot spoof its IP", async () => {
    expect(await ipWith("1", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).toBe("203.0.113.9");
    expect(await ipWith("2", { "x-forwarded-for": "6.6.6.6, 198.51.100.4, 10.0.0.1" })).toBe("198.51.100.4");
  });
  it("ignores forwarding headers entirely with 0 hops", async () => {
    expect(await ipWith("0", { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" })).toBe("unknown");
  });
  it("falls back safely when the chain is shorter than the configured hops", async () => {
    expect(await ipWith("3", { "x-forwarded-for": "203.0.113.9" })).toBe("unknown");
  });
});

describe("log redaction", () => {
  it("removes bearer tokens from URLs and query strings", () => {
    const t = "A".repeat(43);
    expect(redactUrlSecrets(`GET /s/${t} failed`)).not.toContain(t);
    expect(redactUrlSecrets(`https://x.test/intake/${t}?token=abcdef&x=1`)).toBe("https://x.test/intake/[redacted]?token=[redacted]&x=1");
    expect(redactUrlSecrets("/api/contracts/123")).toBe("/api/contracts/123");
  });
});

describe("legal research matrix integrity", () => {
  it("has unique ids, sources, and never invents a verification date", () => {
    const ids = new Set(LEGAL_MATRIX.map((r) => r.id));
    expect(ids.size).toBe(LEGAL_MATRIX.length);
    for (const r of LEGAL_MATRIX) {
      expect(r.source, r.id).toBeTruthy();
      if (r.verification === "unverified") expect(r.lastVerified, r.id).toBeNull();
      else expect(r.lastVerified, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const s = matrixStats();
    expect(s.verified + s.partial + s.unverified).toBe(LEGAL_MATRIX.length);
  });
  it("never claims compliance", () => {
    const text = JSON.stringify(LEGAL_MATRIX).toLowerCase();
    expect(text).not.toMatch(/guarantees? compliance|fully compliant|legally compliant/);
  });
});

async function msg(orgId: string, to = `x-${Math.random().toString(36).slice(2)}@example.test`) {
  const id = await db.transaction((tx) => queueEmail(tx, { orgId, template: "otp_code", toEmail: to, locale: "en", dedupeKey: `t:${Math.random()}`, vars: { recipient_name: "X", contract_name: "C", otp_code: "123456" } }));
  return { id: id!, to };
}

describe("email delivery hardening", () => {
  it("two workers racing on one message send it exactly once", async () => {
    const { org } = await makeOrg();
    const { id, to } = await msg(org.id);
    await Promise.all([deliverEmail(id, 0, 3), deliverEmail(id, 0, 3)]);
    const [m] = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id));
    expect(m!.status).toBe("SENT");
    expect(m!.attempts).toBe(1);
    const s = await (await fetch(`${process.env.MAILPIT_URL ?? "http://127.0.0.1:8025"}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json() as { messages: unknown[] };
    expect(s.messages).toHaveLength(1);
  });

  it("a duplicate provider event changes nothing; opens/clicks are recorded as timestamps, not statuses", async () => {
    const { org } = await makeOrg();
    const { id } = await msg(org.id);
    await deliverEmail(id, 0, 3);
    const at = new Date("2026-09-30T10:00:00Z");
    expect(await recordEmailEvent({ messageId: id, type: "DELIVERED", at })).toBe(true);
    await recordEmailEvent({ messageId: id, type: "DELIVERED", at });
    await recordEmailEvent({ messageId: id, type: "OPEN", at });
    await recordEmailEvent({ messageId: id, type: "CLICK", at: new Date(at.getTime() + 1000) });
    const [m] = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id));
    expect(m!.status).toBe("DELIVERED");
    expect(m!.deliveredAt).toBeTruthy(); expect(m!.openedAt).toBeTruthy(); expect(m!.clickedAt).toBeTruthy();
    expect(await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.emailMessageId, id), eq(schema.emailEvents.type, "DELIVERED")))).toHaveLength(1);
  });

  it("a bounce suppresses future sends to that address (per organisation)", async () => {
    const { org } = await makeOrg();
    const other = await makeOrg();
    const first = await msg(org.id);
    await deliverEmail(first.id, 0, 3);
    await recordEmailEvent({ messageId: first.id, type: "BOUNCE", detail: { reason: "mailbox full" } });
    const again = await msg(org.id, first.to);
    await deliverEmail(again.id, 0, 3);
    const [m] = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, again.id));
    expect(m!.status).toBe("SUPPRESSED");
    const elsewhere = await msg(other.org.id, first.to);
    await deliverEmail(elsewhere.id, 0, 3);
    const [e] = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, elsewhere.id));
    expect(e!.status).toBe("SENT");
  });
});

async function inviteWith(reminders: { afterHours?: number[]; beforeExpiryHours?: number[] }) {
  const { org, user } = await makeOrg();
  const a = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  const { version } = await db.transaction((tx) => createAgreementTemplate(tx, a, { name: "T", agreementType: "ticketing_distribution", jurisdiction: "ENG" }));
  await db.transaction((tx) => publishAgreementVersion(tx, a, version.id));
  const { version: fv } = await db.transaction((tx) => createIntakeForm(tx, a, { title: "F", agreementTemplateVersionId: version.id, workflow: "D", settings: { fixedValues: { organisation_address: "HQ", support_email: "s@x.test" }, reminders: { afterHours: [], beforeExpiryHours: [], ...reminders } } }));
  await db.transaction((tx) => publishFormVersion(tx, a, fv.id));
  const inv = await db.transaction((tx) => sendInvitation(tx, a, { formVersionId: fv.id, recipientName: "R", recipientEmail: "r@example.test" }));
  return { a, inv };
}

describe("intake reminders and token guessing", () => {
  it("sends each reminder slot once, even when the scan runs repeatedly or in parallel", async () => {
    const { inv } = await inviteWith({ afterHours: [24] });
    const later = new Date(Date.now() + 25 * 3_600_000);
    await Promise.all([scanIntakeReminders(later), scanIntakeReminders(later)]);
    await scanIntakeReminders(later);
    const rows = await db.select().from(schema.intakeReminders).where(eq(schema.intakeReminders.invitationId, inv.id));
    expect(rows).toHaveLength(1);
    const mails = await db.select().from(schema.emailMessages).where(and(eq(schema.emailMessages.organisationId, inv.organisationId), eq(schema.emailMessages.template, "intake_reminder")));
    expect(mails).toHaveLength(1);
  });

  it("does not remind after the form was submitted or the link was revoked", async () => {
    const { inv } = await inviteWith({ afterHours: [1] });
    await db.update(schema.intakeInvitations).set({ status: "REVOKED" }).where(eq(schema.intakeInvitations.id, inv.id));
    await scanIntakeReminders(new Date(Date.now() + 5 * 3_600_000));
    expect(await db.select().from(schema.intakeReminders).where(eq(schema.intakeReminders.invitationId, inv.id))).toHaveLength(0);
  });

  it("rate-limits repeated bad-token guesses from one IP", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    let blocked = false;
    for (let i = 0; i < 40 && !blocked; i++) {
      try { await openForm(`${"z".repeat(42)}${i % 10}`, undefined, ctxFor({ ip })); }
      catch (e) { blocked = (e as { code?: string }).code === "rate_limited"; }
    }
    expect(blocked).toBe(true);
  });
});
