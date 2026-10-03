import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { IsoDate, ModeSchema } from "@/server/accounting/core";
import { postEventFee } from "@/server/accounting/manual";

export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ mode: ModeSchema, date: IsoDate }));
  return postEventFee({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Event"), b.mode, b.date);
});
