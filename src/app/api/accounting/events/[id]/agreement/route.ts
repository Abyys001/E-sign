import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { AgreementInput, setAgreement } from "@/server/accounting/entities";

/** New agreement version; applies to transactions imported or re-matched from now on. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const b = await body(req, AgreementInput.extend({ reason: z.string().trim().min(3).max(500) }));
  const { reason, ...ag } = b;
  return setAgreement({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Event"), ag, reason);
});
