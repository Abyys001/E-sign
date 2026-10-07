import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { BulkInput, bulkWise } from "@/server/accounting/wise";

/** Book or classify many Wise movements at once (one record per movement, each linked by its Wise number). */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => bulkWise({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, BulkInput)));
