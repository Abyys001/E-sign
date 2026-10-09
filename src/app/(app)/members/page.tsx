"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, Eye, EyeOff, KeyRound, Lock, Mail, UserPlus, Users, Wand2 } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

type M = { userId: string; name: string; email: string; username: string | null; roleKey: string; hasTotp: boolean; locked: boolean; credentialsManaged: boolean };
type Resp = { members: M[]; roles: Array<{ key: string; name: string }> };
type Method = "password" | "invite";

const BLANK = { name: "", email: "", username: "", password: "", confirm: "", roleKey: "SENDER" };

/** Readable but strong: 18 chars from an alphabet without look-alikes (0/O, 1/l/I). */
function generatePassword() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_";
  const buf = crypto.getRandomValues(new Uint32Array(18));
  return Array.from(buf, (n) => abc[n % abc.length]).join("");
}

/** Suggest a username from the person's email (the part before @), trimmed to the allowed characters. */
const suggestUsername = (email: string) => email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+|[._-]+$/g, "").slice(0, 32);

function PasswordInput({ value, onChange, labels, ...p }: { value: string; onChange: (v: string) => void; labels: { show: string; hide: string } } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...p} type={shown ? "text" : "password"} dir="ltr" autoComplete="new-password" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} className="pe-10" />
      <button type="button" onClick={() => setShown(!shown)} aria-label={shown ? labels.hide : labels.show} className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-muted hover:text-fg">
        {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}

export default function MembersPage() {
  const t = useTranslations("app.members");
  const c = useTranslations("common");
  const toast = useToast();
  const ensure = useElevation();
  const { me } = useMe();
  const { data, loading, reload } = useApi<Resp>("/api/members");
  const pw = { show: t("show"), hide: t("hide") };

  // ---- add member
  const [add, setAdd] = useState(false);
  const [method, setMethod] = useState<Method>("password");
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; username: string; password: string; fresh: boolean } | null>(null);
  const mismatch = method === "password" && !!f.confirm && f.password !== f.confirm;
  const canAdd = !!f.name && !!f.email && (method === "invite" || (!!f.username && f.password.length >= 12 && f.password === f.confirm));
  const openAdd = () => { setErr(null); setF(BLANK); setMethod("password"); setAdd(true); };
  const submitAdd = async () => {
    setBusy(true); setErr(null);
    try {
      const locale = document.documentElement.lang === "fa" ? "fa" : "en";
      if (method === "password") {
        if (!(await ensure())) return;
        const r = await api<{ username: string }>("/api/members", { json: { name: f.name, email: f.email, roleKey: f.roleKey, username: f.username, password: f.password, locale } });
        setCreated({ name: f.name, username: r.username, password: f.password, fresh: true });
      } else {
        await api("/api/members", { json: { name: f.name, email: f.email, roleKey: f.roleKey, locale } });
        toast("ok", t("inviteSent", { email: f.email }));
      }
      setAdd(false); setF(BLANK); await reload();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  // ---- sign-in details of an existing member
  const [cred, setCred] = useState<M | null>(null);
  const [cf, setCf] = useState({ username: "", password: "", confirm: "" });
  const [cErr, setCErr] = useState<string | null>(null);
  const cMismatch = !!cf.confirm && cf.password !== cf.confirm;
  const cChanged = cred ? cf.username.trim().toLowerCase() !== (cred.username ?? "") || !!cf.password : false;
  const canSaveCred = cChanged && (!cf.password || (cf.password.length >= 12 && cf.password === cf.confirm));
  const openCred = async (m: M) => { if (!(await ensure())) return; setCErr(null); setCf({ username: m.username ?? "", password: "", confirm: "" }); setCred(m); };
  const saveCred = async () => {
    if (!cred) return;
    setBusy(true); setCErr(null);
    try {
      if (!(await ensure())) return;
      const username = cf.username.trim();
      await api(`/api/members/${cred.userId}/credentials`, { method: "PATCH", json: { ...(username !== (cred.username ?? "") ? { username: username || null } : {}), ...(cf.password ? { password: cf.password } : {}) } });
      if (cf.password) setCreated({ name: cred.name, username: username || cred.email, password: cf.password, fresh: false });
      else toast("ok", t("credentialsSaved"));
      setCred(null); await reload();
    } catch (e) { setCErr(errMsg(e)); } finally { setBusy(false); }
  };

  const [rm, setRm] = useState<M | null>(null);
  const role = async (m: M, roleKey: string) => { if (!(await ensure())) return; try { await api(`/api/members/${m.userId}`, { method: "PATCH", json: { roleKey } }); await reload(); } catch (e) { toast("error", errMsg(e)); await reload(); } };
  const roleLabel = (k: string, fallback = k) => (t.has(`roles.${k}` as never) ? t(`roles.${k}` as never) : fallback);
  const copyDetails = async () => {
    if (!created) return;
    try { await navigator.clipboard.writeText(t("copyText", { url: `${window.location.origin}/login`, username: created.username, password: created.password })); toast("ok", c("copied")); } catch (e) { toast("error", errMsg(e)); }
  };

  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<Button variant="primary" onClick={openAdd}><UserPlus className="size-4" aria-hidden />{t("add")}</Button>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div> : !data || data.members.length === 0 ? <EmptyState icon={<Users className="size-6" />} title={t("empty")} /> : (
          <TableWrap><Table><thead><tr><Th>{c("name")}</Th><Th>{t("username")}</Th><Th>{c("email")}</Th><Th>{t("role")}</Th><Th><span className="sr-only">{c("actions")}</span></Th></tr></thead>
            <tbody>{data.members.map((m) => (
              <Tr key={m.userId}>
                <Td className="font-medium">{m.name} {m.userId === me.user.id && <span className="text-muted">{t("you")}</span>}
                  {m.locked && <span title={t("lockedHint")} className="ms-2 inline-flex items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-xs font-normal"><Lock className="size-3" aria-hidden />{t("locked")}</span>}</Td>
                <Td dir="ltr" className={cn("text-start", !m.username && "text-muted")}>{m.username ?? <span className="sr-only">{t("noUsername")}</span>}{!m.username && <span aria-hidden>—</span>}</Td>
                <Td className="text-muted">{m.email}</Td>
                <Td><Select aria-label={t("changeRole")} value={m.roleKey} disabled={m.userId === me.user.id} onChange={(e) => role(m, e.target.value)} className="w-auto min-w-44">{[...data.roles.map((r) => r.key), ...(data.roles.some((r) => r.key === m.roleKey) ? [] : [m.roleKey])].map((k) => <option key={k} value={k}>{roleLabel(k)}</option>)}</Select></Td>
                <Td className="text-end"><div className="flex justify-end gap-2">
                  {(m.credentialsManaged || m.userId === me.user.id) && <Button size="sm" onClick={() => openCred(m)}><KeyRound className="size-4" aria-hidden />{t("credentials")}</Button>}
                  {m.userId !== me.user.id && <Button size="sm" onClick={async () => { if (await ensure()) setRm(m); }}>{c("remove")}</Button>}
                </div></Td>
              </Tr>))}</tbody></Table></TableWrap>)}
      </Card>

      <Modal open={add} onClose={() => setAdd(false)} title={t("addTitle")} footer={<><Button onClick={() => setAdd(false)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!canAdd} onClick={submitAdd}>{method === "password" ? t("createAccount") : t("sendInvite")}</Button></>}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (canAdd && !busy) void submitAdd(); }}>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">{t("addTitle")}</legend>
            {([["password", KeyRound, t("methodPassword"), t("methodPasswordHelp")], ["invite", Mail, t("methodInvite"), t("methodInviteHelp")]] as const).map(([id, Icon, label, help]) => (
              <label key={id} className={cn("flex cursor-pointer gap-3 rounded-xl border p-3 text-sm transition", method === id ? "border-fg bg-surface-2" : "border-line-strong hover:border-fg")}>
                <input type="radio" name="method" value={id} checked={method === id} onChange={() => { setMethod(id); setErr(null); }} className="sr-only" />
                <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span><span className="block font-medium">{label}</span><span className="text-xs text-muted">{help}</span></span>
              </label>))}
          </fieldset>
          <Field label={c("name")} required>{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />}</Field>
          <Field label={c("email")} required hint={method === "password" ? t("emailHint") : undefined} error={method === "invite" ? err : null}>{(p) => <Input {...p} type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} onBlur={() => { if (method === "password" && !f.username && f.email.includes("@")) setF((s) => ({ ...s, username: suggestUsername(s.email) })); }} />}</Field>
          {method === "password" && <>
            <Field label={t("username")} required hint={t("usernameHint")}>{(p) => <Input {...p} dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, "") })} />}</Field>
            <Field label={t("password")} required hint={t("passwordHint")}>{(p) => <div className="flex gap-2"><div className="flex-1"><PasswordInput {...p} labels={pw} value={f.password} onChange={(v) => setF({ ...f, password: v })} /></div><Button type="button" onClick={() => { const g = generatePassword(); setF({ ...f, password: g, confirm: g }); }}><Wand2 className="size-4" aria-hidden />{t("generate")}</Button></div>}</Field>
            <Field label={t("confirmPassword")} required error={mismatch ? t("mismatch") : err}>{(p) => <PasswordInput {...p} labels={pw} value={f.confirm} onChange={(v) => setF({ ...f, confirm: v })} />}</Field>
          </>}
          <Field label={t("role")} hint={t.has(`roleHelp.${f.roleKey}` as never) ? t(`roleHelp.${f.roleKey}` as never) : undefined}>{(p) => <Select {...p} value={f.roleKey} onChange={(e) => setF({ ...f, roleKey: e.target.value })}>{data?.roles.map((r) => <option key={r.key} value={r.key}>{roleLabel(r.key, r.name)}</option>)}</Select>}</Field>
          <button type="submit" hidden />
        </form>
      </Modal>

      <Modal open={!!cred} onClose={() => setCred(null)} title={t("credentialsTitle", { name: cred?.name ?? "" })} description={t("credentialsSub")} footer={<><Button onClick={() => setCred(null)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!canSaveCred} onClick={saveCred}>{c("save")}</Button></>}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (canSaveCred && !busy) void saveCred(); }}>
          {cred?.locked && <Callout tone="warn" icon={<Lock className="size-5 shrink-0" aria-hidden />}>{t("lockedHint")}</Callout>}
          <Field label={t("username")} hint={t("usernameHint")}>{(p) => <Input {...p} dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} value={cf.username} onChange={(e) => setCf({ ...cf, username: e.target.value.toLowerCase().replace(/\s/g, "") })} autoFocus />}</Field>
          <Field label={t("newPassword")} hint={t("newPasswordHint")}>{(p) => <div className="flex gap-2"><div className="flex-1"><PasswordInput {...p} labels={pw} value={cf.password} onChange={(v) => setCf({ ...cf, password: v })} /></div><Button type="button" onClick={() => { const g = generatePassword(); setCf({ ...cf, password: g, confirm: g }); }}><Wand2 className="size-4" aria-hidden />{t("generate")}</Button></div>}</Field>
          {!!cf.password && <Field label={t("confirmPassword")} required error={cMismatch ? t("mismatch") : null}>{(p) => <PasswordInput {...p} labels={pw} value={cf.confirm} onChange={(v) => setCf({ ...cf, confirm: v })} />}</Field>}
          {!!cf.password && <p className="text-xs text-muted">{t("passwordResetNote")}</p>}
          {cErr && <p role="alert" className="text-sm font-medium">⚠ {cErr}</p>}
          <button type="submit" hidden />
        </form>
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title={t("credentials")} footer={<><Button onClick={copyDetails}><Copy className="size-4" aria-hidden />{t("copyDetails")}</Button><Button variant="primary" onClick={() => setCreated(null)}>{c("done")}</Button></>}>
        {created && <div className="space-y-4">
          <Callout tone="ok">{created.fresh ? t("created", { name: created.name }) : t("credentialsSaved")}</Callout>
          <dl dir="ltr" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl bg-surface-2 p-4 text-sm">
            <dt className="text-muted">{t("username")}</dt><dd className="break-all font-mono">{created.username}</dd>
            <dt className="text-muted">{t("password")}</dt><dd className="break-all font-mono">{created.password}</dd>
          </dl>
        </div>}
      </Modal>

      <ConfirmDialog open={!!rm} onClose={() => setRm(null)} title={t("remove")} description={t("removeConfirm", { name: rm?.name ?? "" })} confirmLabel={c("remove")} onConfirm={async () => { await api(`/api/members/${rm!.userId}`, { method: "DELETE" }); await reload(); }} />
    </div>
  );
}
