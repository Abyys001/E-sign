import { staffRoute } from "@/server/treasury/http";
import { myCards } from "@/server/treasury/staff-portal";
export const GET = staffRoute(async ({ sc }) => ({ items: await myCards(sc) }));
