import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { revokePhoneDevice } from "@/server/accounting/phone";

/** Sign a phone out of the phone app (own phones; admins: any). */
export const DELETE = acct<{ id: string }>("accounting.view", async ({ auth, ctx, params }) => revokePhoneDevice(auth, ctx, uuid(params.id, "Phone")));
