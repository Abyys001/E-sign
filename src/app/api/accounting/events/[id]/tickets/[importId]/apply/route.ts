import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { applyTicketImport, getTicketImport } from "@/server/accounting/ticket-import";

/** Apply a previewed import: true up the event's booking fee to the export (one balanced correction entry). */
export const POST = acct<{ id: string; importId: string }>("accounting.manage", async ({ auth, ctx, params }) => {
  const importId = uuid(params.importId, "Import");
  if ((await getTicketImport(auth.organisationId, importId)).eventId !== uuid(params.id, "Event")) throw new AppError("not_found", "Import not found");
  return applyTicketImport({ orgId: auth.organisationId, userId: auth.user.id, ctx }, importId);
});
