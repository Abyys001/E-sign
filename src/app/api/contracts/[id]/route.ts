import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid, requireElevation } from "@/server/api";
import { getContractDetail, softDeleteContract, updateContract } from "@/server/contracts/service";
import { can } from "@/server/rbac";

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(), contractType: z.string().trim().min(1).max(60).optional(), message: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(), signingOrder: z.enum(["SEQUENTIAL", "PARALLEL"]).optional(), expiresAt: z.coerce.date().nullable().optional(), rev: z.number().int().optional(),
});

export const GET = authed<{ id: string }>("contracts.view", async ({ auth, params }) => {
  const d = await getContractDetail(auth.organisationId, uuid(params.id, "Contract"));
  const seeAudit = can(auth.membership, "contracts.audit");
  return { ...d, recipients: d.recipients.map(({ passcodeHash, ...r }) => ({ ...r, hasPasscode: !!passcodeHash })), emails: d.emails.map(({ payload: _p, ...m }) => m), sms: d.sms.map(({ payload: _p, ...m }) => m), permissions: { edit: can(auth.membership, "contracts.edit"), send: can(auth.membership, "contracts.send"), cancel: can(auth.membership, "contracts.cancel"), remind: can(auth.membership, "contracts.remind"), download: can(auth.membership, "contracts.download"), audit: seeAudit, override: can(auth.membership, "contracts.override"), delete: can(auth.membership, "contracts.delete") } };
});

export const PATCH = authed<{ id: string }>("contracts.edit", async ({ req, auth, ctx, params }) => {
  const { rev, ...patch } = await body(req, Patch);
  const c = await tx((t) => updateContract(t, actorOf(auth, ctx), uuid(params.id, "Contract"), patch, rev));
  return { id: c.id, rev: c.rev };
});

export const DELETE = authed<{ id: string }>("contracts.delete", async ({ auth, ctx, params }) => {
  requireElevation(auth);
  await tx((t) => softDeleteContract(t, actorOf(auth, ctx), uuid(params.id, "Contract")));
  return { ok: true };
});
