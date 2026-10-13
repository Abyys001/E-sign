import { acct } from "@/server/accounting/http";
import { cashForecast } from "@/server/accounting/forecast";

/** 7 / 30 / 90-day cash-flow forecast per currency (estimate; read-only). */
export const GET = acct("accounting.view", async ({ auth, mode }) => cashForecast(auth.organisationId, mode));
