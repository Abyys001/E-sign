import { rematchUnmatched, repostRefundsForPolicy } from "@/server/accounting/manual";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { tx } from "@/server/api";
import { getAcctSettings, SettingsPatch, updateAcctSettings } from "@/server/accounting/core";

export const GET = acct("accounting.view", async ({ auth }) => getAcctSettings(auth.organisationId));

export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => {
  const b = await body(req, SettingsPatch);
  const s = await tx((t) => updateAcctSettings(t, auth.organisationId, auth.user.id, b, ctx));
  const policy = b.bookingFeeRefundable !== undefined ? await repostRefundsForPolicy(auth.organisationId, { userId: auth.user.id }) : null;
  return { ...s, rematch: await rematchUnmatched(auth.organisationId, { userId: auth.user.id }), policy };
});
