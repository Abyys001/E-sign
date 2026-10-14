import { staffRoute } from "@/server/treasury/http";
import { myCards } from "@/server/treasury/staff-portal";
export const GET = staffRoute(async ({ sc }) => ({
  staff: { name: sc.staff.name, email: sc.staff.email, canFreezeCard: sc.staff.canFreezeCard },
  csrf: sc.csrf, cards: await myCards(sc),
}));
