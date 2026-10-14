import { z } from "zod";
import { staffRoute } from "@/server/treasury/http";
import { body } from "@/server/http";
import { freezeCard } from "@/server/treasury/staff-portal";
export const POST = staffRoute(async ({ req, sc }) => {
  const b = await body(req, z.object({ cardId: z.string().uuid().optional().nullable(), freeze: z.boolean() }));
  return freezeCard(sc, b.cardId ?? null, b.freeze);
});
