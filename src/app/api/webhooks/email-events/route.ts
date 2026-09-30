import { z } from "zod";
import { AppError } from "@/server/errors";
import { safeEqual } from "@/server/crypto";
import { open, body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { inboundEventsSecret, recordEmailEvent } from "@/server/messaging/events";

const B = z.object({ events: z.array(z.object({ messageId: z.string().min(1).max(200), type: z.enum(["DELIVERED", "BOUNCE", "COMPLAINT", "OPEN", "CLICK"]), at: z.string().datetime().optional(), detail: z.unknown().optional() })).min(1).max(100) });

/** Provider delivery events (normalised shape). Authenticated with a shared secret; this is what moves a contract from SENT to DELIVERED. */
export const POST = open(async ({ req, ctx }) => {
  await rateLimit("api", `inbound-email:${ctx.ip}`);
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!safeEqual(given, inboundEventsSecret())) throw new AppError("unauthenticated", "Invalid credentials.");
  const { events } = await body(req, B);
  let applied = 0;
  for (const e of events) if (await recordEmailEvent({ messageId: e.messageId, type: e.type, at: e.at ? new Date(e.at) : undefined, detail: e.detail })) applied++;
  return { received: events.length, applied };
});
