import { body, open } from "@/server/http";
import { UnlockInput, unlockPhone } from "@/server/accounting/phone";

/** Unlock the phone app with its PIN. */
export const POST = open(async ({ req, ctx }) => unlockPhone(ctx, await body(req, UnlockInput)));
