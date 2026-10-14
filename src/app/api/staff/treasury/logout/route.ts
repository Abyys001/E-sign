import { staffPublic } from "@/server/treasury/http";
import { destroyStaffSession } from "@/server/treasury/auth";
export const POST = staffPublic(async () => { await destroyStaffSession(); return { ok: true }; });
