import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { uuid } from "@/server/api";
import { contractCandidates, LinkContract, linkContract, organiserContracts, unlinkContract } from "@/server/accounting/organiser-contracts";

/** Contracts linked to this organiser; `?q=` also returns contracts that can be linked. */
export const GET = acct<{ id: string }>("accounting.view", async ({ req, auth, params }) => {
  const id = uuid(params.id, "Organiser");
  const q = query(req, z.object({ q: z.string().trim().max(120).optional(), candidates: z.enum(["1"]).optional() }).passthrough());
  return { items: await organiserContracts(auth.organisationId, id), candidates: q.candidates || q.q ? await contractCandidates(auth.organisationId, q.q) : [] };
});
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => linkContract({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Organiser"), await body(req, LinkContract)));
export const DELETE = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => unlinkContract({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Organiser"), (await body(req, z.object({ linkId: z.string().uuid() }))).linkId));
