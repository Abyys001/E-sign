import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid, Pagination } from "@/server/api";
import { query } from "@/server/http";
import { listInvitations, sendInvitation } from "@/server/intake/invitations";

export const GET = authed<{ id: string }>("intake.view", async ({ req, auth, params }) => {
  const p = query(req, Pagination);
  return { items: await listInvitations(auth.organisationId, { formId: uuid(params.id, "Form"), limit: p.pageSize, offset: (p.page - 1) * p.pageSize }) };
});
export const POST = authed<{ id: string }>("intake.send", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ formVersionId: z.string().uuid(), recipientName: z.string().trim().min(1).max(200), recipientEmail: z.email().max(254), authMode: z.enum(["NONE", "EMAIL_OTP", "PASSCODE"]).optional(), passcode: z.string().min(6).max(100).optional(), expiryDays: z.number().int().min(1).max(180).optional(), message: z.string().max(2000).optional() }));
  uuid(params.id, "Form");
  const inv = await tx((t) => sendInvitation(t, actorOf(auth, ctx), b));
  return Response.json({ id: inv.id, expiresAt: inv.expiresAt }, { status: 201 });
});
