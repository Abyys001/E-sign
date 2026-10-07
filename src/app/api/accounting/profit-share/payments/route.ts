import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { PartnerPaymentInput, recordPartnerPayment } from "@/server/accounting/profit-share";

export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => recordPartnerPayment({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, PartnerPaymentInput)));
