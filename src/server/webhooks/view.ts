import type { schema } from "@/db";

export const webhookView = (h: typeof schema.webhooks.$inferSelect) => ({ id: h.id, url: h.url, events: h.events, enabled: h.enabled, createdAt: h.createdAt });
