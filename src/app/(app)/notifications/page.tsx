"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/form";
import { api, fmtDate, useApi } from "@/lib/api";
import { ek } from "@/lib/i18n-key";

type N = { id: string; type: string; contractId: string | null; data: Record<string, string>; readAt: string | null; createdAt: string };

export default function NotificationsPage() {
  const t = useTranslations("app.notifications");
  const locale = useLocale();
  const [unread, setUnread] = useState(false);
  const { data, loading, reload } = useApi<{ items: N[]; unread: number }>(`/api/notifications${unread ? "?unread=1" : ""}`);
  const markAll = async () => { await api("/api/notifications/read", { json: { all: true } }); await reload(); };
  const open = async (n: N) => { if (!n.readAt) await api("/api/notifications/read", { json: { ids: [n.id] } }).catch(() => {}); };
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("title")} description={t("sub")} actions={<><Checkbox label={t("unreadOnly")} checked={unread} onChange={(e) => setUnread(e.target.checked)} /><Button onClick={markAll} disabled={!data?.unread}><CheckCheck className="size-4" aria-hidden />{t("markAll")}</Button></>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          : !data || data.items.length === 0 ? <EmptyState icon={<Bell className="size-6" />} title={unread ? t("emptyUnread") : t("empty")} />
          : <ul className="divide-y divide-line">{data.items.map((n) => {
            const key = `types.${ek(n.type)}`;
            const text = t.has(key as never) ? t(key as never, { contractName: "", by: "", to: "", template: "", ...n.data } as never) : n.type;
            const body = <span className="flex items-start gap-3"><span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${n.readAt ? "border border-line-strong" : "bg-accent"}`} /><span className="min-w-0 flex-1"><span className={`block text-sm ${n.readAt ? "" : "font-medium"}`}>{text}</span><time dateTime={n.createdAt} className="text-xs text-muted">{fmtDate(n.createdAt, locale)}</time></span></span>;
            return <li key={n.id}>{n.contractId ? <Link href={`/contracts/${n.contractId}`} onClick={() => open(n)} className="block px-5 py-3.5 hover:bg-surface-2">{body}</Link> : <div className="px-5 py-3.5">{body}</div>}</li>;
          })}</ul>}
      </Card>
    </div>
  );
}
