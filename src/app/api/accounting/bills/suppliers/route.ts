import { acct } from "@/server/accounting/http";
import { suppliers } from "@/server/accounting/books";

export const GET = acct("accounting.view", async ({ auth }) => ({ items: await suppliers(auth.organisationId) }));
