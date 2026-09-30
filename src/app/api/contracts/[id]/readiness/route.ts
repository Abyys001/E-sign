import { db } from "@/db";
import { authed } from "@/server/http";
import { uuid } from "@/server/api";
import { getContractRow, readiness } from "@/server/contracts/service";

export const GET = authed<{ id: string }>("contracts.view", async ({ auth, params }) => {
  const c = await getContractRow(auth.organisationId, uuid(params.id, "Contract"));
  const issues = await readiness(db, c.id);
  return { ready: issues.length === 0, issues };
});
