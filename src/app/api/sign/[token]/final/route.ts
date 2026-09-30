import { AppError } from "@/server/errors";
import { open } from "@/server/http";
import { serveArtifact } from "@/server/download";
import { loadByToken } from "@/server/signing/service";

/** After the whole contract is complete, a recipient who signed can download the final PDF and certificate with the same link. */
export const GET = open<{ token: string }>(async ({ req, ctx, params }) => {
  const l = await loadByToken(params.token, ctx);
  if (l.recipient.status !== "COMPLETED" || l.contract.status !== "COMPLETED") throw new AppError("not_found", "The final document is not ready yet.");
  const a = req.nextUrl.searchParams.get("artifact") ?? "final";
  if (a !== "final" && a !== "certificate") throw new AppError("bad_request", "Unknown document type.");
  return serveArtifact({ orgId: l.contract.organisationId, contractId: l.contract.id, artifact: a, recipientId: l.recipient.id, ctx, rateKey: l.request.id });
});
