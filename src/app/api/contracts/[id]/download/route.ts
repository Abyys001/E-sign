import { AppError } from "@/server/errors";
import { authed } from "@/server/http";
import { uuid } from "@/server/api";
import { serveArtifact } from "@/server/download";
import { getContractRow } from "@/server/contracts/service";

export const GET = authed<{ id: string }>("contracts.download", async ({ req, auth, ctx, params }) => {
  const a = req.nextUrl.searchParams.get("artifact") ?? "final";
  if (!["source", "final", "certificate"].includes(a)) throw new AppError("bad_request", "Unknown document type.");
  const c = await getContractRow(auth.organisationId, uuid(params.id, "Contract"));
  return serveArtifact({ orgId: auth.organisationId, contractId: c.id, artifact: a as "source" | "final" | "certificate", userId: auth.user.id, ctx, rateKey: auth.user.id });
});
