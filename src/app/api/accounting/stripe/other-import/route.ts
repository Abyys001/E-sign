import { acct } from "@/server/accounting/http";
import { AppError } from "@/server/errors";
import { applyOtherStripe, previewOtherStripe } from "@/server/accounting/other-stripe";

/**
 * Upload (multipart field `file`) the Payments CSV export of Bilit's other Stripe account. `apply=1` books every new
 * payment; without it the file is only read and matched (preview, nothing posted).
 */
export const POST = acct("accounting.manage", async ({ req, auth, ctx, mode }) => {
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the CSV as multipart/form-data."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_failed", "Choose a CSV file.", [{ path: "file", message: "Required" }]);
  if (file.size > 20_000_000) throw new AppError("payload_too_large", "The file is larger than 20 MB.");
  const csv = await file.text();
  return form.get("apply") === "1"
    ? applyOtherStripe({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, csv, file.name.slice(0, 200))
    : previewOtherStripe(auth.organisationId, mode, csv);
});
