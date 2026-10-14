import { acct } from "@/server/accounting/http";
import { dashboardStatus } from "@/server/accounting/command-centre";

/** Stripe integration status + review counts for the dashboard alert panel. No secrets are returned. */
export const GET = acct("accounting.view", async ({ auth, mode }) => dashboardStatus(auth.organisationId, mode));
