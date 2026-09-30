import { AppError } from "@/server/errors";
import { open } from "@/server/http";
import { uploadFile } from "@/server/intake/public";
import { cookieOf } from "../../cookie";

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the file as multipart form data."); });
  const file = form.get("file"), field = form.get("field");
  if (!(file instanceof File) || typeof field !== "string") throw new AppError("bad_request", "A file and a field are required.");
  if (file.size > 15 * 1024 * 1024) throw new AppError("payload_too_large", "Files must be at most 15 MB.");
  return uploadFile(params.token, cookieOf(req, params.token), { fieldKey: field, filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, ctx);
});
