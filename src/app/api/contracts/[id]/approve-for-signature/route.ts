import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { approveForSignature } from "@/server/intake/process";

export const POST = authed<{ id: string }>("contracts.send", async ({ req, auth, ctx, params }) => {
  const person = z.object({ name: z.string().trim().min(1).max(200), email: z.email().max(254) });
  const b = await body(req, z.object({ organiser: person, bilit: person, order: z.enum(["organiser_first", "bilit_first"]).optional(), expiryDays: z.number().int().min(1).max(180).optional() }));
  return tx((t) => approveForSignature(t, actorOf(auth, ctx), uuid(params.id, "Contract"), b));
});
