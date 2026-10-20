import { body, open } from "@/server/http";
import { PairInput, pairPhone } from "@/server/accounting/phone";

/** Set up this phone from a scanned one-time QR code + a new 6-digit PIN (no sign-in on the phone). */
export const POST = open(async ({ req, ctx }) => pairPhone(ctx, await body(req, PairInput)));
