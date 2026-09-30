import { authed, query } from "@/server/http";
import { csvCell } from "@/server/audit-export";
import { ListQuery, exportContractRows } from "@/server/contracts/list";
import { db } from "@/db";
import { audit } from "@/server/audit";

export const GET = authed("contracts.view", async ({ req, auth, ctx }) => {
  const p = query(req, ListQuery);
  const head = ["reference", "name", "status", "type", "created", "sent", "expires", "completed", "sender", "recipients"];
  const enc = new TextEncoder();
  let n = 0;
  const stream = new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(`﻿${head.join(",")}\n`));
      for await (const r of exportContractRows(auth.organisationId, p)) {
        n++;
        c.enqueue(enc.encode(`${[r.reference, r.name, r.status, r.type, r.created?.toISOString(), r.sent?.toISOString(), r.expires?.toISOString(), r.completed?.toISOString(), r.sender, r.recipients].map(csvCell).join(",")}\n`));
      }
      await db.transaction((tx) => audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "contracts.exported", ctx, metadata: { rows: n } }));
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="contracts.csv"', "cache-control": "private, no-store" } });
});
