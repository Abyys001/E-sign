import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { ModeSchema } from "@/server/accounting/core";
import { disconnectStripe } from "@/server/accounting/stripe-gateway";

/** Destroys stored credentials for one mode. Imported transactions and the ledger are kept. */
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  await disconnectStripe({ orgId: auth.organisationId, userId: auth.user.id, mode: (await body(req, z.object({ mode: ModeSchema }))).mode, ctx });
  return { ok: true };
});
