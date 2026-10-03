"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { faBan, faCircleCheck, faFilePdf, faFileSignature, faMoneyBillTransfer, faMoneyCheckDollar, faPen, faPenRuler, faPlus, faStamp } from "@fortawesome/free-solid-svg-icons";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Money, useMode } from "@/components/accounting/kit";
import { Fa, PayslipDialog, type EmployeeRow, type PayslipRow } from "@/components/accounting/books";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

const ST = { DRAFT: ["border-line-strong bg-surface-2 text-muted", faPenRuler], FINAL: ["border-fin-info/40 bg-fin-info/12 text-fin-info", faStamp], PAID: ["border-fin-pos/40 bg-fin-pos/12 text-fin-pos", faCircleCheck], VOIDED: ["border-line-strong text-muted", faBan] } as const;

export default function Page() { return <Suspense><Payslips /></Suspense>; }

function Payslips() {
  const t = useTranslations("accounting.books.ps");
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { mode, q } = useMode();
  const sp = useSearchParams();
  const [employeeId, setEmployeeId] = useState(sp.get("employeeId") ?? "");
  const [status, setStatus] = useState("");
  const allowed = can("accounting.payroll");
  const emps = useApi<{ items: EmployeeRow[] }>(allowed ? q("/api/accounting/employees") : null);
  const { data, loading, reload } = useApi<{ items: PayslipRow[] }>(allowed ? q(`/api/accounting/payslips?x=1${employeeId ? `&employeeId=${employeeId}` : ""}${status ? `&status=${status}` : ""}`) : null);
  const [dlg, setDlg] = useState<PayslipRow | "new" | null>(null);
  const [fin, setFin] = useState<PayslipRow | null>(null); const [pay, setPay] = useState<PayslipRow | null>(null); const [del, setDel] = useState<PayslipRow | null>(null);
  const [reason, setReason] = useState(""); const [pv, setPv] = useState({ paidDate: new Date().toISOString().slice(0, 10), paymentReference: "" }); const [busy, setBusy] = useState(false);
  if (!allowed) return <EmptyState title={t("forbidden")} />;
  const employees = emps.data?.items ?? [];
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast("ok", ok); await reload(); return true; } catch (e) { toast("error", errMsg(e)); return false; } finally { setBusy(false); } };
  const byCur = new Map<string, { gross: number; net: number; employer: number }>();
  for (const p of data?.items ?? []) if (p.status === "FINAL" || p.status === "PAID") { const x = byCur.get(p.currency) ?? { gross: 0, net: 0, employer: 0 }; x.gross += p.grossPay; x.net += p.netPay; x.employer += p.employerTotal; byCur.set(p.currency, x); }
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("sub")} actions={<Button variant="primary" disabled={!employees.length} onClick={() => setDlg("new")}><Fa icon={faPlus} />{t("new")}</Button>} />
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t("employee")} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="w-auto"><option value="">{t("allEmployees")}</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>
        <Select aria-label={t("status")} value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto"><option value="">{t("anyStatus")}</option>{(["DRAFT", "FINAL", "PAID", "VOIDED"] as const).map((s) => <option key={s} value={s}>{t(`st.${s}`)}</option>)}</Select>
        {[...byCur.entries()].map(([c, x]) => <Card key={c} className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 text-sm"><span className="font-semibold uppercase">{c}</span><span><span className="text-muted">{t("gross")}: </span><Money v={x.gross} c={c} /></span><span><span className="text-muted">{t("net")}: </span><Money v={x.net} c={c} strong /></span><span><span className="text-muted">{t("employerTotal")}: </span><Money v={x.employer} c={c} /></span></Card>)}
      </div>
      {!employees.length && emps.data && <Card><EmptyState icon={<Fa icon={faMoneyCheckDollar} className="text-2xl" />} title={t("noEmployees")} description={t("noEmployeesDesc")} /></Card>}
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          : !data?.items.length ? <EmptyState icon={<Fa icon={faFileSignature} className="text-2xl" />} title={t("empty")} description={t("emptyDesc")} /> : (
          <TableWrap><Table className="text-[13px] [&_td]:px-3 [&_th]:px-3"><thead><tr><Th>{t("number")}</Th><Th>{t("employee")}</Th><Th>{t("period")}</Th><Th>{t("payDate")}</Th><Th className="text-end">{t("gross")}</Th><Th className="text-end">{t("totalDeductions")}</Th><Th className="text-end">{t("net")}</Th><Th className="text-end">{t("employerTotal")}</Th><Th>{t("status")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((p) => { const [cls, icon] = ST[p.status as keyof typeof ST] ?? ST.VOIDED; return <Tr key={p.id} className={p.status === "VOIDED" ? "text-muted" : ""}>
              <Td className="whitespace-nowrap font-mono text-xs">{p.number ?? <span className="text-muted">{t("st.DRAFT")}</span>}</Td>
              <Td><span className="font-medium">{p.employeeName}</span>{p.employeeRef && <span className="block text-xs text-muted">{p.employeeRef}</span>}</Td>
              <Td className="whitespace-nowrap">{p.periodStart} – {p.periodEnd}</Td><Td>{p.payDate}</Td>
              <Td className="text-end"><Money v={p.grossPay} c={p.currency} /></Td><Td className="text-end text-muted">−<Money v={p.totalDeductions} c={p.currency} /></Td><Td className="text-end"><Money v={p.netPay} c={p.currency} strong /></Td><Td className="text-end text-muted"><Money v={p.employerTotal} c={p.currency} /></Td>
              <Td><span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", cls)}><Fa icon={icon} className="text-[10px]" />{t(`st.${p.status}`)}</span>{p.voidReason && <span className="block text-xs">{p.voidReason}</span>}{p.paidDate && <span className="block text-xs text-muted">{p.paidDate}</span>}</Td>
              <Td className="text-end"><div className="flex justify-end gap-1">
                <a href={`/api/accounting/payslips/${p.id}/pdf`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-surface-2" aria-label={t("pdf")}><Fa icon={faFilePdf} className="text-fin-neg" />{p.status === "DRAFT" ? t("preview") : "PDF"}</a>
                {p.status === "DRAFT" && <><Button size="sm" variant="ghost" aria-label={t("editDraft")} onClick={() => setDlg(p)}><Fa icon={faPen} className="text-xs" /></Button><Button size="sm" variant="primary" onClick={() => setFin(p)}><Fa icon={faStamp} className="text-xs" />{t("finalise")}</Button></>}
                {p.status === "FINAL" && <Button size="sm" onClick={() => { setPv({ paidDate: p.payDate, paymentReference: "" }); setPay(p); }}><Fa icon={faMoneyBillTransfer} className="text-xs" />{t("markPaid")}</Button>}
                {p.status !== "VOIDED" && p.status !== "DRAFT" && <Button size="sm" variant="ghost" aria-label={t("void")} onClick={async () => { if (await ensure()) { setReason(""); setDel(p); } }}><Fa icon={faBan} className="text-xs" /></Button>}
              </div></Td></Tr>; })}</tbody></Table></TableWrap>)}
      </Card>
      {dlg && <PayslipDialog mode={mode} employees={employees} payslip={dlg === "new" ? undefined : dlg} onClose={() => setDlg(null)} onSaved={() => void reload()} />}
      <ConfirmDialog open={!!fin} onClose={() => setFin(null)} danger={false} title={t("finaliseTitle")} description={t("finaliseDesc")} confirmLabel={t("finalise")}
        onConfirm={async () => { if (!(await act(() => api(`/api/accounting/payslips/${fin!.id}/finalise`, { json: {} }), t("finalised")))) throw new Error("failed"); }}>
        {fin && <p className="text-sm">{fin.employeeName} · {fin.periodStart} – {fin.periodEnd} · <strong><Money v={fin.netPay} c={fin.currency} /></strong></p>}
      </ConfirmDialog>
      {pay && <Modal open onClose={() => setPay(null)} title={t("payTitle")} description={`${pay.number} · ${pay.employeeName}`}
        footer={<><Button onClick={() => setPay(null)}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={async () => { if (await act(() => api(`/api/accounting/payslips/${pay.id}/pay`, { json: { paidDate: pv.paidDate, paymentReference: pv.paymentReference || null } }), t("paid"))) setPay(null); }}>{t("markPaid")}</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2"><Field label={t("paidDate")}>{(p) => <Input {...p} type="date" value={pv.paidDate} onChange={(e) => setPv({ ...pv, paidDate: e.target.value })} />}</Field><Field label={t("reference")}>{(p) => <Input {...p} value={pv.paymentReference} onChange={(e) => setPv({ ...pv, paymentReference: e.target.value })} />}</Field></div>
      </Modal>}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={t("voidTitle")} description={t("voidDesc")} confirmLabel={t("void")}
        onConfirm={async () => { if (!(await act(() => api(`/api/accounting/payslips/${del!.id}/void`, { json: { reason } }), t("voided")))) throw new Error("failed"); }}>
        <Field label={t("reason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </div>
  );
}
