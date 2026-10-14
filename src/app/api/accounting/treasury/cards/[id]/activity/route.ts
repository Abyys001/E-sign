import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { adminCardActivity } from "@/server/treasury/admin";
export const GET = acct<{ id: string }>("treasury.admin", async ({ auth, params }) => adminCardActivity(auth.organisationId, uuid(params.id, "Card")));
