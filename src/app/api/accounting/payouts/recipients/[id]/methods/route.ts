import { acct } from "@/server/accounting/http";
import { AppError } from "@/server/errors";
import { recipientPayoutMethods } from "@/server/accounting/stripe-payouts";

export const GET = acct<{ id: string }>("accounting.manage", async ({ auth, mode, params }) => {
  if (!/^acct_[A-Za-z0-9]+$/.test(params.id)) throw new AppError("bad_request", "Invalid recipient");
  return { items: await recipientPayoutMethods(auth.organisationId, mode, params.id) };
});
