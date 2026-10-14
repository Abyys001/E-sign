import { AppError } from "@/server/errors";
import { staffRoute } from "@/server/treasury/http";
import { uploadReceipt } from "@/server/treasury/staff-portal";
export const POST = staffRoute(async ({ req, sc }) => {
  const form = await req.formData();
  const file = form.get("file"); const cardId = (form.get("cardId") as string) || null; const stripeObjectId = form.get("stripeObjectId") as string;
  if (!(file instanceof File)) throw new AppError("validation_failed", "Attach a file.");
  if (!stripeObjectId) throw new AppError("validation_failed", "Missing transaction reference.");
  return uploadReceipt(sc, cardId, stripeObjectId, Buffer.from(await file.arrayBuffer()), file.name || "receipt");
});
