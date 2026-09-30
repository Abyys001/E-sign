import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { addRecipient } from "@/server/contracts/service";

export const RecipientBody = z.object({
  name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email().max(254), phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Use international format, e.g. +447700900123").nullish().or(z.literal("")),
  company: z.string().trim().max(120).nullish(), role: z.enum(["SIGNER", "CC", "WITNESS", "APPROVER"]).optional(), signingOrder: z.number().int().min(1).max(50).optional(),
  required: z.boolean().optional(), internal: z.boolean().optional(), authLevel: z.enum(["LINK", "EMAIL_OTP", "SMS_OTP", "PASSCODE", "ACCOUNT"]).optional(), passcode: z.string().min(4).max(64).nullish(), smsConsent: z.boolean().optional(),
});

export const POST = authed<{ id: string }>("contracts.edit", async ({ req, auth, ctx, params }) => {
  const b = await body(req, RecipientBody);
  const r = await tx((t) => addRecipient(t, actorOf(auth, ctx), uuid(params.id, "Contract"), b));
  return Response.json({ id: r.id }, { status: 201 });
});
