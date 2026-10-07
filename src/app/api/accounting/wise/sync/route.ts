import { acct } from "@/server/accounting/http";
import { rateLimit } from "@/server/rate-limit";
import { syncWise } from "@/server/accounting/wise";

/** Import transfers, balances and (with SCA) statements from Wise now. Read-only towards Wise. */
export const POST = acct("accounting.manage", async ({ auth, ctx }) => {
  await rateLimit("accountingSync", auth.user.id);
  return syncWise(auth.organisationId, { userId: auth.user.id, ctx });
});
