import { staffRoute } from "@/server/treasury/http";
import { staffReceipt } from "@/server/treasury/staff-portal";
import { Readable } from "node:stream";
export const GET = staffRoute<{ id: string }>(async ({ sc, params }) => {
  const r = await staffReceipt(sc, params.id);
  return new Response(Readable.toWeb(r.stream) as ReadableStream, { headers: { "content-type": r.contentType, "content-disposition": `inline; filename="${r.name.replace(/[^A-Za-z0-9_.-]/g, "_")}"`, "cache-control": "private, no-store" } });
});
