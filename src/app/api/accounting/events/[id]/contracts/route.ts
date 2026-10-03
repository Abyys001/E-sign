import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { eventContracts } from "@/server/accounting/organiser-contracts";

/** Contract status for an event (its Event Schedule and the organiser's master agreement). */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => eventContracts(auth.organisationId, uuid(params.id, "Event")));
