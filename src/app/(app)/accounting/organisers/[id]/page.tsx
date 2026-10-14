"use client";
import Link from "next/link";
import { Suspense, use, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Banknote, Bot, CalendarPlus, Download, Eye, Pencil, Send } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Badge, DL, Money, RangePicker, rangeFor, rangeQuery, useExport, useMode, type RangeKey } from "@/components/accounting/kit";
import { OrganiserFinance, PortalUsers } from "@/components/accounting/organiser-finance";
import { OrganiserContracts, OrganiserPayments, OrganiserRefunds, OrganiserReports } from "@/components/accounting/organiser-tabs";
import { LinkEventsDialog, OrganiserDialog, PaymentDialog } from "@/components/accounting/forms";
import { PaymentAgentDialog } from "@/components/accounting/payment-agent";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

type Bal = { currency: string; grossSales: number; refunds: number; chargebacks: number; stripeFeesRecharged: number; commission: number; organiserPayable: number; organiserPayments: number; organiserOutstanding: number };
type D = { organiser: { id: string; name: string; email: string | null; companyName: string | null; vatNumber: string | null; address: string | null; internalRef: string | null; notes: string | null; active: boolean; hasBankDetails: boolean; bankHint: string | null; cashbackBps: number; cashbackFrom: string | null };
  events: Array<{ id: string; name: string; code: string; currency: string; status: string }>; balances: Bal[] };
type Row = { entryId: string; date: string; entryType: string; description: string; order: string | null; customer: string | null; eventName: string | null; eventCode: string | null; sales: number; refunds: number; fees: number; commission: number; payments: number; change: number; balance: number };

const TABS = ["overview", "events", "payments", "refunds", "statement", "contracts", "reports", "details"] as const;
type TabId = (typeof TABS)[number];

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <Suspense><OrganiserDetail id={id} /></Suspense>; }

function OrganiserDetail({ id }: { id: string }) {
  const t = useTranslations("accounting.organisers");
  const tp = useTranslations("accounting.payouts");
  const ta = useTranslations("accounting.payagent");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const exp = useExport();
  const { can } = useMe();
  const { mode, q } = useMode();
  const router = useRouter();
  const sp = useSearchParams();
  const tab: TabId = (TABS as readonly string[]).includes(sp.get("tab") ?? "") ? (sp.get("tab") as TabId) : "overview";
  const setTab = (v: TabId) => router.replace(`/accounting/organisers/${id}${v === "overview" ? "" : `?tab=${v}`}`, { scroll: false });
  const { data, loading, error, reload } = useApi<D>(q(`/api/accounting/organisers/${id}`));
  const [refresh, setRefresh] = useState(0);
  const [edit, setEdit] = useState(false); const [pay, setPay] = useState(false); const [agent, setAgent] = useState(false); const [linkOpen, setLinkOpen] = useState(false);
  const [bank, setBank] = useState<Record<string, string | null> | null>(null);
  const [cur, setCur] = useState<string>(""); const [page, setPage] = useState(1);
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const currency = cur || data?.balances[0]?.currency || data?.events[0]?.currency || "eur";
  const rq = rangeQuery(rangeFor(range.key, range));
  const st = useApi<{ openingBalance: number; rows: Row[]; page: number; pageSize: number }>(data ? q(`/api/accounting/organisers/${id}/statement?currency=${currency}&page=${page}&pageSize=50${rq}`) : null);
  if (loading && !data) return <Skeleton className="h-64" />;
  if (error || !data) return <EmptyState title={t("notFound")} description={error?.message} />;
  const o = data.organiser;
  const reveal = async () => { if (!(await ensure())) return; try { setBank((await api<{ bankDetails: Record<string, string | null> }>(`/api/accounting/organisers/${id}/bank`)).bankDetails); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <div className="space-y-6">
      <PageHeader title={<span className="flex items-center gap-3">{o.name} <Badge s={o.active ? "ACTIVE" : "INACTIVE"} /></span>} description={[o.companyName, o.cashbackBps ? t("cashbackBadge", { pct: o.cashbackBps / 100 }) : null].filter(Boolean).join(" · ") || undefined}
        actions={<><LinkButton href="/accounting/organisers"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t("back")}</LinkButton>
          {can("accounting.manage") && <><Button onClick={() => setEdit(true)}><Pencil className="size-4" aria-hidden />{t("edit")}</Button><Button onClick={() => setAgent(true)}><Bot className="size-4" aria-hidden />{ta("open")}</Button><Button variant="primary" onClick={() => setPay(true)}><Banknote className="size-4" aria-hidden />{t("recordPayment")}</Button></>}
          {can("accounting.admin") && <LinkButton href={`/accounting/payouts?type=ORGANISER&id=${id}`}><Send className="size-4" aria-hidden />{tp("payStripe")}</LinkButton>}</>} />
      <Tabs tabs={TABS.map((k) => ({ id: k, label: t(`tabs.${k}`) }))} value={tab} onChange={setTab} label={t("tabs.label")} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="space-y-6">
      {tab === "overview" && <OrganiserFinance id={id} refresh={refresh} />}
      {tab === "events" && <>
        <Card><CardHeader title={t("eventsTitle")} description={t("eventsDesc")} action={can("accounting.manage") && <Button size="sm" variant="primary" onClick={() => setLinkOpen(true)}><CalendarPlus className="size-4" aria-hidden />{t("linkEvents")}</Button>} />
          {data.events.length === 0 ? <EmptyState title={t("noEvents")} /> : <ul className="divide-y divide-line">{data.events.map((e) => <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm"><Link href={`/accounting/events/${e.id}`} className="font-medium underline-offset-4 hover:underline">{e.name}</Link><span className="flex items-center gap-2"><code className="text-xs">{e.code}</code><Badge s={e.status} /></span></li>)}</ul>}
        </Card>
      </>}
      {tab === "payments" && <OrganiserPayments key={refresh} id={id} onPay={() => setPay(true)} onChanged={() => { void reload(); setRefresh((x) => x + 1); }} />}
      {tab === "refunds" && <OrganiserRefunds key={refresh} id={id} />}
      {tab === "contracts" && <OrganiserContracts id={id} events={data.events} />}
      {tab === "reports" && <OrganiserReports id={id} currencies={[...new Set([...data.balances.map((b) => b.currency), ...data.events.map((e) => e.currency)])]} />}
      {tab === "details" && <div className="grid gap-6 lg:grid-cols-2">
        <Card><CardHeader title={t("details")} /><div className="p-5"><DL items={[
          [t("internalRef"), o.internalRef], [t("email"), o.email], [t("company"), o.companyName], [t("vat"), o.vatNumber], [t("address"), o.address],
          [t("bank"), o.hasBankDetails ? bank ? <span key="b" className="whitespace-pre-line">{[bank.accountHolder, bank.iban, bank.bic, bank.bankName, bank.notes].filter(Boolean).join("\n")}</span> : <span key="b" className="flex items-center gap-2">{o.bankHint}{can("accounting.manage") && <Button size="sm" variant="ghost" onClick={reveal}><Eye className="size-3.5" aria-hidden />{t("reveal")}</Button>}</span> : null],
          [t("notes"), o.notes],
        ]} /></div></Card>
        <PortalUsers id={id} />
      </div>}
      {tab === "statement" && <>
      <Card>
        <CardHeader title={t("statement")} description={t("statementDesc")} action={<div className="flex flex-wrap items-center gap-2">
          <Select aria-label={t("currency")} value={currency} onChange={(e) => { setCur(e.target.value); setPage(1); }} className="w-auto">{[...new Set([...data.balances.map((b) => b.currency), ...data.events.map((e) => e.currency)])].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</Select>
          <RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
          <Button size="sm" onClick={() => exp(ensure, q(`/api/accounting/organisers/${id}/statement?currency=${currency}${rq}`))}><Download className="size-4" aria-hidden />CSV</Button></div>} />
        {!st.data ? <div className="p-4"><Skeleton className="h-24" /></div> : !st.data.rows.length ? <EmptyState title={t("noStatement")} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("s.date")}</Th><Th>{t("s.event")}</Th><Th>{t("s.order")}</Th><Th>{t("s.customer")}</Th><Th className="text-end">{t("s.sales")}</Th><Th className="text-end">{t("s.refunds")}</Th><Th className="text-end">{t("s.fees")}</Th><Th className="text-end">{t("s.commission")}</Th><Th className="text-end">{t("s.payments")}</Th><Th className="text-end">{t("s.balance")}</Th></tr></thead>
            <tbody>
              {page === 1 && range.key !== "all" && <Tr><Td colSpan={9} className="text-muted">{t("s.opening")}</Td><Td className="text-end"><Money v={st.data.openingBalance} c={currency} /></Td></Tr>}
              {st.data.rows.map((r) => <Tr key={r.entryId}><Td className="whitespace-nowrap">{r.date}</Td><Td>{r.eventCode ? <code className="text-xs">{r.eventCode}</code> : "—"}</Td><Td>{r.order ? <code className="text-xs">{r.order}</code> : <span className="text-muted" title={r.description}>{r.entryType}</span>}</Td><Td className="max-w-56 truncate">{r.customer ?? (r.order ? "—" : r.description)}</Td>
                {[r.sales, r.refunds, r.fees, r.commission, r.payments].map((v, i) => <Td key={i} className="text-end">{v ? <Money v={v} c={currency} /> : ""}</Td>)}<Td className="text-end"><Money v={r.balance} c={currency} strong /></Td></Tr>)}
            </tbody></Table></TableWrap>
          <Pagination page={page} pageSize={50} total={(page - 1) * 50 + st.data.rows.length + (st.data.rows.length === 50 ? 1 : 0)} onPage={setPage} /></>}
      </Card>
      </>}
      </div>
      {edit && <OrganiserDialog open={edit} onClose={() => setEdit(false)} onSaved={() => void reload()} organiserId={id} hasBank={o.hasBankDetails} initial={{ name: o.name, email: o.email ?? "", companyName: o.companyName ?? "", vatNumber: o.vatNumber ?? "", address: o.address ?? "", internalRef: o.internalRef ?? "", notes: o.notes ?? "", active: o.active, cashbackPercent: o.cashbackBps ? String(o.cashbackBps / 100) : "", cashbackFrom: o.cashbackFrom ?? "" }} />}
      {linkOpen && <LinkEventsDialog organiserId={id} onClose={() => setLinkOpen(false)} onSaved={() => { void reload(); void st.reload(); }} />}
      {agent && <PaymentAgentDialog open={agent} onClose={() => setAgent(false)} onSaved={() => { void reload(); void st.reload(); setRefresh((x) => x + 1); }} organiserId={id} />}
      {pay && <PaymentDialog open={pay} onClose={() => setPay(false)} onSaved={() => { void reload(); void st.reload(); setRefresh((x) => x + 1); }} mode={mode} organiserId={id} />}
      <span className="sr-only">{locale}</span>
    </div>
  );
}
