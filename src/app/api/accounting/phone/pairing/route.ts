import { acct } from "@/server/accounting/http";
import { requireElevation } from "@/server/api";
import { createPairing } from "@/server/accounting/phone";

/** One-time QR code (10 minutes) that sets up the phone app for the signed-in user. Needs re-authentication. */
export const POST = acct("accounting.view", async ({ auth, ctx }) => {
  requireElevation(auth);
  return createPairing(auth, ctx);
});
