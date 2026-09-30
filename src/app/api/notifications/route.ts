import { authed } from "@/server/http";
import { listNotifications, unreadCount } from "@/server/notifications";

export const GET = authed(null, async ({ req, auth }) => {
  const unreadOnly = req.nextUrl.searchParams.get("unread") === "1";
  const [items, unread] = await Promise.all([listNotifications(auth.organisationId, auth.user.id, unreadOnly), unreadCount(auth.organisationId, auth.user.id)]);
  return { items, unread };
});
