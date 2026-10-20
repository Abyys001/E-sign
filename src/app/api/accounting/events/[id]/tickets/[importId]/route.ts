import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { getTicketImport } from "@/server/accounting/ticket-import";

/** One import with its per-order lines. */
export const GET = acct<{ id: string; importId: string }>("accounting.view", async ({ auth, params }) => {
  const x = await getTicketImport(auth.organisationId, uuid(params.importId, "Import"));
  if (x.eventId !== uuid(params.id, "Event")) throw new AppError("not_found", "Import not found");
  return x;
});
