import { acct } from "@/server/accounting/http";
import { listPhoneDevices } from "@/server/accounting/phone";

/** Phones set up for the phone app: your own (admins: everyone's). */
export const GET = acct("accounting.view", async ({ auth }) => listPhoneDevices(auth));
