import { open } from "@/server/http";
import { phoneStatus } from "@/server/accounting/phone";

/** Phone app: set-up needed, locked (PIN), or unlocked. */
export const GET = open(async () => phoneStatus());
