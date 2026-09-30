import { z } from "zod";
import { authed, query } from "@/server/http";
import { uuid } from "@/server/api";
import { describeFormVersion } from "@/server/intake/forms";

export const GET = authed<{ vid: string }>("intake.view", async ({ req, auth, params }) => {
  const q = query(req, z.object({ name: z.string().max(200).optional(), email: z.string().max(254).optional() }));
  return describeFormVersion(auth.organisationId, uuid(params.vid, "Form version"), q.name && q.email ? { name: q.name, email: q.email } : undefined);
});
