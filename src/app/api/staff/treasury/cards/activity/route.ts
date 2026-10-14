import { staffRoute } from "@/server/treasury/http";
import { cardActivity } from "@/server/treasury/staff-portal";
export const GET = staffRoute(async ({ req, sc }) => cardActivity(sc, req.nextUrl.searchParams.get("cardId")));
