import { z } from "zod";
import { authed, body, query } from "@/server/http";
import { actorOf, tx, Pagination } from "@/server/api";
import { createContract } from "@/server/contracts/service";
import { listContracts, ListQuery } from "@/server/contracts/list";
import { duplicateContract } from "@/server/contracts/service";

const Create = z.object({
  name: z.string().trim().min(1).max(200), contractType: z.string().trim().min(1).max(60).optional(), message: z.string().max(2000).nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(), signingOrder: z.enum(["SEQUENTIAL", "PARALLEL"]).optional(),
  expiresAt: z.coerce.date().nullish(), templateVersionId: z.string().uuid().nullish(), duplicateOf: z.string().uuid().nullish(),
  variables: z.record(z.string().max(60), z.string().max(2000)).optional(),
  recipients: z.array(z.object({
    roleKey: z.string().min(1).max(60), name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(320), phone: z.string().max(30).nullish(), company: z.string().max(200).nullish(),
    authLevel: z.enum(["LINK", "EMAIL_OTP", "SMS_OTP", "PASSCODE", "ACCOUNT"]).optional(), passcode: z.string().max(100).nullish(), internal: z.boolean().optional(), smsConsent: z.boolean().optional(),
  })).max(50).optional(),
});

export const GET = authed("contracts.view", async ({ req, auth }) => listContracts(auth.organisationId, query(req, ListQuery.and(Pagination))));

export const POST = authed("contracts.create", async ({ req, auth, ctx }) => {
  const b = await body(req, Create);
  const a = actorOf(auth, ctx);
  const c = await tx(async (t) => {
    if (b.duplicateOf) return duplicateContract(t, a, b.duplicateOf);
    if (b.templateVersionId) {
      const { createFromTemplate } = await import("@/server/templates/service");
      return createFromTemplate(t, a, b.templateVersionId, { name: b.name, variables: b.variables, recipients: b.recipients, metadata: b.metadata, message: b.message ?? null, expiresAt: b.expiresAt ?? null });
    }
    return createContract(t, a, { ...b, message: b.message ?? null, expiresAt: b.expiresAt ?? null });
  });
  return Response.json({ id: c.id, reference: c.reference, status: c.status }, { status: 201 });
});
