"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, Link2, X } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { PaymentDialog } from "@/components/accounting/forms";
import { Badge, Money, useExport, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { api, errMsg } from "@/lib/api";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { fmtDate, useApi } from "@/lib/api";
import { StripeNav } from "../nav";

type P = { id: string; payoutId: string; amount: number; currency: string; status: string; automatic: boolean; arrivalDate: string | null; stripeCreatedAt: string; stripeAccountId: string | null; includedCount: number | null; includedNet: number | null; reconciliationStatus: string; linkedPayments: Array<{ id: string; organiser: string; eventCode: string | null; amount: number; currency: string }>; failureMessage: string | null };

export default function PayoutsPage() {
  const t = useTranslations("accounting.stripe.payouts");
  const locale = useLocale();
  const ensure = useElevation();
  const exp = useExport();
  const { can } = useMe();
  const { mode, q } = useMode();
  const [page, setPage] = useState(1);
  const [link, setLink] = useState<P | null>(null);
  const [sel, setSel] = useState<Record<string, P>>({});
  const [bulk, setBulk] = useState(false);
  const { data, loading, reload } = useApi<{ items: P[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/stripe/payouts?page=${page}&pageSize=50`));
  const selectable = (data?.items ?? []).filter((x) => !x.linkedPayments.length && !["failed", "canceled"].includes(x.status));
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<Button onClick={() => exp(ensure, q("/api/accounting/stripe/payouts?x=1"))}><Download className="size-4" aria-hidden />{t("export")}</Button>} />
      <StripeNav />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : <>
          {Object.keys(sel).length > 0 && <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-accent-soft px-4 py-2.5 text-sm">
            <span className="font-medium">{t("selected", { n: Object.keys(sel).length })}</span>
            <span className="text-muted">{Object.entries(Object.values(sel).reduce<Record<string, number>>((o, x) => ((o[x.currency] = (o[x.currency] ?? 0) + x.amount), o), {})).map(([c, v]) => <Money key={c} v={v} c={c} className="me-3" />)}</span>
            <Button size="sm" variant="primary" onClick={() => setBulk(true)}><Link2 className="size-3.5" aria-hidden />{t("linkSelected", { n: Object.keys(sel).length })}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSel({})}><X className="size-3.5" aria-hidden />{t("clear")}</Button>
          </div>}
          <TableWrap><Table><thead><tr>{can("accounting.manage") && <Th className="w-8"><input type="checkbox" aria-label={t("selectAll")} checked={selectable.length > 0 && selectable.every((x) => sel[x.payoutId])} onChange={(e) => setSel(e.target.checked ? { ...sel, ...Object.fromEntries(selectable.map((x) => [x.payoutId, x])) } : {})} /></Th>}<Th>{t("id")}</Th><Th>{t("date")}</Th><Th>{t("arrival")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th>{t("account")}</Th><Th>{t("included")}</Th><Th>{t("recon")}</Th><Th>{t("organiser")}</Th></tr></thead>
            <tbody>{data.items.map((p) => <Tr key={p.id} className={sel[p.payoutId] ? "bg-accent-soft/60" : ""}>
              {can("accounting.manage") && <Td className="w-8">{!p.linkedPayments.length && !["failed", "canceled"].includes(p.status) && <input type="checkbox" aria-label={t("select", { id: p.payoutId })} checked={!!sel[p.payoutId]} onChange={(e) => setSel((o) => { const n = { ...o }; if (e.target.checked) n[p.payoutId] = p; else delete n[p.payoutId]; return n; })} />}</Td>}
              <Td><Link href={`/accounting/transactions?payoutId=${p.payoutId}`} className="underline-offset-4 hover:underline"><code className="text-xs">{p.payoutId}</code></Link>{!p.automatic && <span className="block text-xs text-muted">{t("manual")}</span>}</Td>
              <Td className="whitespace-nowrap text-muted">{fmtDate(p.stripeCreatedAt, locale, { dateStyle: "medium" })}</Td><Td className="whitespace-nowrap">{p.arrivalDate ? fmtDate(p.arrivalDate, locale, { dateStyle: "medium" }) : "—"}</Td>
              <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td><Badge s={p.status} />{p.failureMessage && <span className="block text-xs text-muted">{p.failureMessage}</span>}</Td>
              <Td><code className="text-xs">{p.stripeAccountId ?? "—"}</code></Td><Td>{p.includedCount ?? "—"}{p.includedNet != null && <span className="block text-xs text-muted"><Money v={p.includedNet} c={p.currency} /></span>}</Td><Td><Badge s={p.reconciliationStatus} /></Td>
              <Td className="min-w-44">{p.linkedPayments.length ? p.linkedPayments.map((l) => <span key={l.id} className="block text-sm"><span className="font-medium">{l.organiser}</span>{l.eventCode && <code className="ms-1 text-xs text-muted">{l.eventCode}</code>}{l.amount !== p.amount && <span className="ms-1 text-xs text-muted"><Money v={l.amount} c={l.currency} /></span>}</span>)
                : can("accounting.manage") && !["failed", "canceled"].includes(p.status) ? <Button size="sm" onClick={() => setLink(p)}><Link2 className="size-3.5" aria-hidden />{t("link")}</Button> : <span className="text-muted">—</span>}</Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      <p className="mt-3 text-xs text-muted">{t("linkHelp")}</p>
      {bulk && <BulkLinkDialog payouts={Object.values(sel)} onClose={() => setBulk(false)} onDone={() => { setSel({}); void reload(); }} />}
      {link && <PaymentDialog open onClose={() => setLink(null)} onSaved={() => void reload()} mode={mode}
        prefill={{ amount: link.amount, currency: link.currency, paymentDate: (link.arrivalDate ?? link.stripeCreatedAt).slice(0, 10), bankReference: link.payoutId, method: "STRIPE_TRANSFER", notes: "Paid out through Stripe" }} />}
    </div>
  );
}

type Ev = { id: string; name: string; code: string; currency: string; organiserId: string | null };
/** Link the selected payouts to one organiser, with an optional event per currency. One organiser payment per payout. */
function BulkLinkDialog({ payouts, onClose, onDone }: { payouts: P[]; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("accounting.stripe.payouts");
  const c = useTranslations("common");
  const toast = useToast();
  const { q } = useMode();
  const { data: orgs } = useApi<{ items: Array<{ id: string; name: string }> }>("/api/accounting/organisers?pageSize=200&active=true");
  const { data: evs } = useApi<{ items: Ev[] }>("/api/accounting/events?pageSize=200");
  const [organiserId, setOrganiserId] = useState("");
  const [eventBy, setEventBy] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState(""); const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const byCur = useMemo(() => Object.entries(payouts.reduce<Record<string, { n: number; total: number }>>((o, x) => { const g = (o[x.currency] ??= { n: 0, total: 0 }); g.n++; g.total += x.amount; return o; }, {})), [payouts]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ created: number; skipped: Array<{ payoutId: string; reason: string }> }>(q("/api/accounting/stripe/payouts/link"), { json: { payoutIds: payouts.map((x) => x.payoutId), organiserId, eventByCurrency: Object.fromEntries(byCur.map(([cur]) => [cur, eventBy[cur] || null])), notes: notes || null } });
      toast("ok", t("bulkDone", { n: r.created, skipped: r.skipped.length })); onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t("bulkTitle", { n: payouts.length })} description={t("bulkDesc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!organiserId || !confirm} onClick={submit}><Link2 className="size-4" aria-hidden />{t("linkSelected", { n: payouts.length })}</Button></>}>
      <div className="space-y-4">
        <Field label={t("bulkOrganiser")} required>{(p) => <Select {...p} value={organiserId} onChange={(e) => { setOrganiserId(e.target.value); setEventBy({}); }}><option value="">—</option>{orgs?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
        {byCur.map(([cur, g]) => <Field key={cur} label={t("bulkEvent", { c: cur.toUpperCase(), n: g.n })} hint={t("bulkEventHint")}>{(p) => <Select {...p} value={eventBy[cur] ?? ""} disabled={!organiserId} onChange={(e) => setEventBy({ ...eventBy, [cur]: e.target.value })}>
          <option value="">{t("bulkNoEvent")}</option>{(evs?.items ?? []).filter((e) => e.currency === cur && e.organiserId === organiserId).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}</Select>}</Field>)}
        <ul className="max-h-48 divide-y divide-line overflow-auto rounded-xl border border-line text-sm">{payouts.map((x) => <li key={x.payoutId} className="flex justify-between gap-2 px-3 py-1.5"><code className="text-xs">{x.payoutId}</code><span className="text-muted">{(x.arrivalDate ?? x.stripeCreatedAt).slice(0, 10)}</span><Money v={x.amount} c={x.currency} strong /></li>)}</ul>
        <Field label={t("bulkNotes")}>{(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-14" />}</Field>
        <Checkbox label={t("bulkConfirm")} checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}
