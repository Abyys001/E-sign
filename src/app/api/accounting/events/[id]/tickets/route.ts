import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { listTicketImports, previewTicketImport } from "@/server/accounting/ticket-import";

/** Ticket-export imports of the event (newest first) and the one currently applied. */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params, mode }) => listTicketImports(auth.organisationId, mode, uuid(params.id, "Event")));

/** Upload (multipart field `file`) a ticket-system CSV export: parsed and reconciled against Stripe as a preview, nothing posted. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params, mode }) => {
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the CSV as multipart/form-data."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_failed", "Choose a CSV file.", [{ path: "file", message: "Required" }]);
  if (file.size > 20_000_000) throw new AppError("payload_too_large", "The file is larger than 20 MB.");
  return previewTicketImport({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, uuid(params.id, "Event"), await file.text(), file.name.slice(0, 200));
});
