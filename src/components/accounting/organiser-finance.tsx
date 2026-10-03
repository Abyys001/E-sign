"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarDays, Coins, HandCoins, Percent, Receipt, Scale, Undo2, UserPlus, Wallet, X } from "lucide-react";
import { useMe } from "@/components/app/me";
import { AmountCard, Money, useMode } from "@/components/accounting/kit";
import { pct, SettlementBadge, type Fig } from "@/components/accounting/finance";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Stat } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

type Row = Fig & { eventId: string; eventName: string; eventCode: string; startsOn: string | null; bookingFeeBps: number | null };

/** Organiser → Financials: account totals per currency and settlement per event. */
export function OrganiserFinance({ id, refresh }: { id: string; refresh: number }) {
  const t = useTranslations("accounting.fin");
  const locale = useLocale();
  const { q } = useMode();
  const { data } = useApi<{ eventCount: number; totals: Fig[]; events: Row[] }>(q(`/api/accounting/organisers/${id}/financials?r=${refresh}`));
  const [cur, setCur] = useState<string | null>(null);
  if (!data) return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>;
  const f = data.totals.find((x) => x.currency === cur) ?? data.totals[0];
  return (
    <section aria-label={t("orgFin.title")} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("orgFin.title")}</h2>
        <div className="flex items-center gap-3">{f && <SettlementBadge s={f.settlement} />}
          {data.totals.length > 1 && <Select aria-label={t("currency")} value={f?.currency} onChange={(e) => setCur(e.target.value)} className="w-auto font-semibold uppercase">{data.totals.map((x) => <option key={x.currency} value={x.currency}>{x.currency.toUpperCase()}</option>)}</Select>}</div>
      </div>
      {!f ? <Card><EmptyState title={t("orgFin.empty")} /></Card> : <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label={t("orgFin.events")} value={data.eventCount} icon={<CalendarDays className="size-4" aria-hidden />} hint={<>{t("k.tickets")}: {f.tickets.toLocaleString(locale)}</>} />
          <AmountCard label={t("k.grossSales")} v={f.grossSales} c={f.currency} tone="pos" icon={Receipt} />
          <AmountCard label={t("k.bookingFees")} v={f.bookingFees} c={f.currency} tone="pos" icon={Percent} />
          <AmountCard label={t("k.refunds")} v={f.refunds + f.chargebacks} c={f.currency} tone="neg" icon={Undo2} />
          <AmountCard label={t("orgFin.expenses")} v={f.expensesOrganiser} c={f.currency} tone="warn" icon={Coins} hint={t("orgFin.expensesHint")} />
          <AmountCard label={t("k.organiserDue")} v={f.organiserDue} c={f.currency} tone="info" icon={Scale} />
          <AmountCard label={t("k.organiserPaid")} v={f.organiserPaid} c={f.currency} tone="bal" icon={Wallet} />
          <AmountCard label={t("k.remaining")} v={f.remaining} c={f.currency} tone={f.remaining === 0 ? "pos" : "warn"} icon={HandCoins} />
        </div>
        <Card><CardHeader title={t("orgFin.byEvent")} />
          <TableWrap><Table><thead><tr><Th>{t("events.event")}</Th><Th className="text-end">{t("events.tickets")}</Th><Th className="text-end">{t("events.gross")}</Th><Th className="text-end">{t("events.fee")}</Th><Th className="text-end">{t("events.due")}</Th><Th className="text-end">{t("events.paid")}</Th><Th className="text-end">{t("events.remaining")}</Th><Th>{t("settlement.label")}</Th></tr></thead>
            <tbody>{data.events.filter((e) => e.currency === f.currency).map((e) => <Tr key={e.eventId}>
              <Td className="min-w-56"><Link href={`/accounting/events/${e.eventId}`} className="font-medium underline-offset-4 hover:underline">{e.eventName}</Link><span className="block text-xs text-muted"><code>{e.eventCode}</code>{e.startsOn ? ` · ${e.startsOn}` : ""}</span></Td>
              <Td className="text-end tabular-nums">{e.tickets.toLocaleString(locale)}</Td><Td className="text-end"><Money v={e.grossSales} c={e.currency} /></Td>
              <Td className="text-end"><Money v={e.bookingFees} c={e.currency} /><span className="block text-xs text-muted">{pct(e.bookingFeeBps)}</span></Td>
              <Td className="text-end"><Money v={e.organiserDue} c={e.currency} /></Td><Td className="text-end"><Money v={e.organiserPaid} c={e.currency} /></Td><Td className="text-end"><Money v={e.remaining} c={e.currency} strong /></Td><Td><SettlementBadge s={e.settlement} /></Td></Tr>)}</tbody></Table></TableWrap>
          {f.organiserPaid !== data.events.filter((e) => e.currency === f.currency).reduce((s, e) => s + e.organiserPaid, 0) && <p className="border-t border-line px-5 py-3 text-xs text-muted">{t("orgFin.unassigned")}</p>}
        </Card>
      </>}
    </section>
  );
}

/** Organiser portal access: members who can see this organiser's own figures. */
export function PortalUsers({ id }: { id: string }) {
  const t = useTranslations("accounting.fin.portalUsers");
  const toast = useToast();
  const { can } = useMe();
  const { data, reload } = useApi<{ linked: Array<{ userId: string; name: string; email: string }>; members: Array<{ userId: string; name: string; email: string; roleKey: string }> }>(can("accounting.admin") ? `/api/accounting/organisers/${id}/users` : null);
  const [pick, setPick] = useState("");
  if (!can("accounting.admin") || !data) return null;
  const free = data.members.filter((m) => !data.linked.some((l) => l.userId === m.userId));
  const call = async (method: "POST" | "DELETE", userId: string) => { try { await api(`/api/accounting/organisers/${id}/users`, { method, json: { userId } }); setPick(""); await reload(); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <Card><CardHeader title={t("title")} description={t("desc")} />
      <div className="space-y-3 p-5">
        {data.linked.length === 0 ? <p className="text-sm text-muted">{t("none")}</p> : <ul className="divide-y divide-line rounded-xl border border-line">{data.linked.map((u) => <li key={u.userId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span>{u.name} <span className="text-muted">{u.email}</span></span><Button size="sm" variant="ghost" onClick={() => call("DELETE", u.userId)} aria-label={t("remove")}><X className="size-3.5" aria-hidden /></Button></li>)}</ul>}
        <div className="flex flex-wrap gap-2"><Select aria-label={t("member")} value={pick} onChange={(e) => setPick(e.target.value)} className="w-auto min-w-56 flex-1"><option value="">{t("choose")}</option>{free.map((m) => <option key={m.userId} value={m.userId}>{m.name} — {m.email}</option>)}</Select>
          <Button disabled={!pick} onClick={() => call("POST", pick)}><UserPlus className="size-4" aria-hidden />{t("add")}</Button></div>
        <p className="text-xs text-muted">{t("note")}</p>
      </div>
    </Card>
  );
}
