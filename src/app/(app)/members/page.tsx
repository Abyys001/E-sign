"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { UserPlus, Users } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

type M = { userId: string; name: string; email: string; roleKey: string; hasTotp: boolean };
type Resp = { members: M[]; roles: Array<{ key: string; name: string }> };

export default function MembersPage() {
  const t = useTranslations("app.members");
  const c = useTranslations("common");
  const toast = useToast();
  const ensure = useElevation();
  const { me } = useMe();
  const { data, loading, reload } = useApi<Resp>("/api/members");
  const [inv, setInv] = useState(false);
  const [f, setF] = useState({ name: "", email: "", roleKey: "SENDER" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rm, setRm] = useState<M | null>(null);
  const invite = async () => { setBusy(true); setErr(null); try { await api("/api/members", { json: { ...f, locale: document.documentElement.lang === "fa" ? "fa" : "en" } }); toast("ok", t("inviteSent", { email: f.email })); setInv(false); setF({ name: "", email: "", roleKey: "SENDER" }); await reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const role = async (m: M, roleKey: string) => { if (!(await ensure())) return; try { await api(`/api/members/${m.userId}`, { method: "PATCH", json: { roleKey } }); await reload(); } catch (e) { toast("error", errMsg(e)); await reload(); } };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<Button variant="primary" onClick={() => { setErr(null); setInv(true); }}><UserPlus className="size-4" aria-hidden />{t("invite")}</Button>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div> : !data || data.members.length === 0 ? <EmptyState icon={<Users className="size-6" />} title={t("empty")} /> : (
          <TableWrap><Table><thead><tr><Th>{c("name")}</Th><Th>{c("email")}</Th><Th>{t("role")}</Th><Th><span className="sr-only">{c("actions")}</span></Th></tr></thead>
            <tbody>{data.members.map((m) => (
              <Tr key={m.userId}><Td className="font-medium">{m.name} {m.userId === me.user.id && <span className="text-muted">{t("you")}</span>}</Td><Td className="text-muted">{m.email}</Td>
                <Td><Select aria-label={t("changeRole")} value={m.roleKey} disabled={m.userId === me.user.id} onChange={(e) => role(m, e.target.value)} className="w-auto min-w-44">{[...data.roles.map((r) => r.key), ...(data.roles.some((r) => r.key === m.roleKey) ? [] : [m.roleKey])].map((k) => <option key={k} value={k}>{t.has(`roles.${k}` as never) ? t(`roles.${k}` as never) : k}</option>)}</Select></Td>
                <Td className="text-end">{m.userId !== me.user.id && <Button size="sm" onClick={async () => { if (await ensure()) setRm(m); }}>{c("remove")}</Button>}</Td></Tr>))}</tbody></Table></TableWrap>)}
      </Card>
      <Modal open={inv} onClose={() => setInv(false)} title={t("inviteTitle")} footer={<><Button onClick={() => setInv(false)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.name || !f.email} onClick={invite}>{t("invite")}</Button></>}>
        <div className="space-y-4">
          <Field label={c("name")} required>{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />}</Field>
          <Field label={c("email")} required error={err}>{(p) => <Input {...p} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label={t("role")} hint={t.has(`roleHelp.${f.roleKey}` as never) ? t(`roleHelp.${f.roleKey}` as never) : undefined}>{(p) => <Select {...p} value={f.roleKey} onChange={(e) => setF({ ...f, roleKey: e.target.value })}>{data?.roles.map((r) => <option key={r.key} value={r.key}>{t.has(`roles.${r.key}` as never) ? t(`roles.${r.key}` as never) : r.name}</option>)}</Select>}</Field>
        </div>
      </Modal>
      <ConfirmDialog open={!!rm} onClose={() => setRm(null)} title={t("remove")} description={t("removeConfirm", { name: rm?.name ?? "" })} confirmLabel={c("remove")} onConfirm={async () => { await api(`/api/members/${rm!.userId}`, { method: "DELETE" }); await reload(); }} />
    </div>
  );
}
