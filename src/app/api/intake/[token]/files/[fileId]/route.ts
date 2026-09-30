import { open } from "@/server/http";
import { removeFile } from "@/server/intake/public";
import { uuid } from "@/server/api";
import { cookieOf } from "../../../cookie";

export const DELETE = open<{ token: string; fileId: string }>(async ({ req, ctx, params }) => removeFile(params.token, cookieOf(req, params.token), uuid(params.fileId, "File"), ctx));
