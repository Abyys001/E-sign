import { acct } from "@/server/accounting/http";
import { listWiseProfiles } from "@/server/accounting/wise";

export const GET = acct("accounting.admin", async ({ auth }) => ({ items: await listWiseProfiles(auth.organisationId) }));
