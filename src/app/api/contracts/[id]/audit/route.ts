import { authed, query } from "@/server/http";
import { uuid, requireElevation } from "@/server/api";
import { verifyAuditChain } from "@/server/audit";
import { getContractRow, listContractEvents } from "@/server/contracts/service";
import { exportAudit } from "@/server/audit-export";
import { can } from "@/server/rbac";
import { AppError } from "@/server/errors";
import { z } from "zod";

export const GET = authed<{ id: string }>("contracts.audit", async ({ req, auth, ctx, params }) => {
  const c = await getContractRow(auth.organisationId, uuid(params.id, "Contract"));
  const { format } = query(req, z.object({ format: z.enum(["json", "csv", "events"]).default("events") }));
  if (format !== "events") {
    if (!can(auth.membership, "audit.export")) throw new AppError("forbidden", "You do not have permission to export audit data.");
    requireElevation(auth);
    const out = await exportAudit({ orgId: auth.organisationId, userId: auth.user.id, ctx, contractId: c.id, format });
    return new Response(out.body, { headers: { "content-type": out.contentType, "content-disposition": `attachment; filename="audit-${c.reference}.${format}"`, "cache-control": "private, no-store" } });
  }
  const [events, chain] = await Promise.all([listContractEvents(auth.organisationId, c.id), verifyAuditChain(c.id)]);
  return { chain, events: events.map((e) => ({ ...e, seq: Number(e.seq) })) };
});
