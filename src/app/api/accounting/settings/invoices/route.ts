import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { getInvoiceSettings, InvoiceSettings, updateInvoiceSettings } from "@/server/accounting/invoices";

export const GET = acct("accounting.view", async ({ auth }) => getInvoiceSettings(auth.organisationId));
export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => updateInvoiceSettings({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, InvoiceSettings)));
