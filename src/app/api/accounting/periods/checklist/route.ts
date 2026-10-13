import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { periodChecklist } from "@/server/accounting/period-close";

const Q = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).passthrough();

/** Month-end checklist: what is still open in a month before it is closed. Read-only. */
export const GET = acct("accounting.view", async ({ req, auth }) => periodChecklist(auth.organisationId, query(req, Q).period));
