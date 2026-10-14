import { staffRoute } from "@/server/treasury/http";
import { body } from "@/server/http";
import { LimitRequestInput, myLimitRequests, requestLimit } from "@/server/treasury/staff-portal";
export const GET = staffRoute(async ({ sc }) => ({ items: await myLimitRequests(sc) }));
export const POST = staffRoute(async ({ req, sc }) => requestLimit(sc, await body(req, LimitRequestInput)));
