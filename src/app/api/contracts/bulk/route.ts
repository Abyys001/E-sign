import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx } from "@/server/api";
import { archiveContract, cancelContract, remindRecipient } from "@/server/contracts/service";
import { can } from "@/server/rbac";
import { AppError } from "@/server/errors";

const B = z.object({ action: z.enum(["archive", "cancel", "remind"]), ids: z.array(z.string().uuid()).min(1).max(100) });

/** Each contract runs in its own transaction with its own permission check; one failure never blocks the rest. */
export const POST = authed("contracts.view", async ({ req, auth, ctx }) => {
  const b = await body(req, B);
  const need = { archive: "contracts.edit", cancel: "contracts.cancel", remind: "contracts.remind" } as const;
  if (!can(auth.membership, need[b.action])) throw new AppError("forbidden", "You do not have permission to do that.");
  const a = actorOf(auth, ctx);
  const results = [];
  for (const id of b.ids) {
    try {
      await tx(async (t) => (b.action === "archive" ? archiveContract(t, a, id) : b.action === "cancel" ? cancelContract(t, a, id) : remindRecipient(t, a, id)));
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, error: e instanceof Error ? e.message : "Failed" }); }
  }
  return { results, succeeded: results.filter((r) => r.ok).length };
});
