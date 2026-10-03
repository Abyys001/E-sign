import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { transactionDetail } from "@/server/accounting/queries";

export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => transactionDetail(auth.organisationId, uuid(params.id, "Transaction")));
