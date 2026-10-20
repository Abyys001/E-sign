import { open } from "@/server/http";
import { lockPhone } from "@/server/accounting/phone";

/** Lock the phone app (the PIN is needed again). */
export const POST = open(async () => lockPhone());
