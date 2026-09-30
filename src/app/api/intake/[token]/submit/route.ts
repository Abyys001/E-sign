import { open } from "@/server/http";
import { submitForm } from "@/server/intake/public";
import { cookieOf } from "../../cookie";

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => submitForm(params.token, cookieOf(req, params.token), { idempotencyKey: req.headers.get("idempotency-key") ?? undefined }, ctx));
