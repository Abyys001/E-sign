"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Copy, KeyRound, Plus, RefreshCw, Send, Trash2, Webhook } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Switch } from "@/components/ui/form";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { ek } from "@/lib/i18n-key";

type Hook = { id: string; url: string; events: string[]; enabled: boolean; createdAt: string };
type Delivery = { id: string; event: string; status: string; attempts: number; lastStatusCode: number | null; lastError: string | null; createdAt: string };
type Key = { id: string; name: string; prefix: string; permissions: string[]; lastUsedAt: string | null; createdAt: string };
const KEY_PERMS = ["contracts.view", "contracts.create", "contracts.edit", "contracts.send", "contracts.cancel", "contracts.remind", "contracts.download", "templates.view"];

export default function DevelopersPage() {
  const t = useTranslations("app.developers");
  const c = useTranslations("common");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const hooks = useApi<{ events: string[]; items: Hook[] }>("/api/webhooks");
  const keys = useApi<{ keys: Key[] }>("/api/api-keys");
  const [edit, setEdit] = useState<{ id?: string; url: string; events: string[]; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [del, setDel] = useState<Hook | null>(null);
  const [dl, setDl] = useState<Hook | null>(null);
  const deliveries = useApi<{ items: Delivery[] }>(dl ? `/api/webhooks/${dl.id}/deliveries` : null);
  const [newKey, setNewKey] = useState<{ name: string; perms: string[] } | null>(null);
  const [revoke, setRevoke] = useState<Key | null>(null);
  const evName = (e: string) => (t.has(`eventNames.${ek(e)}` as never) ? t(`eventNames.${ek(e)}` as never) : e);
  const copy = (v: string) => { void navigator.clipboard.writeText(v); toast("ok", c("copied")); };

  const saveHook = async () => {
    if (!edit || !(await ensure())) return;
    setBusy(true); setErr(null);
    try {
      const body = { url: edit.url, events: edit.events, enabled: edit.enabled };
      if (edit.id) await api(`/api/webhooks/${edit.id}`, { method: "PATCH", json: body });
      else { const r = await api<{ secret: string }>("/api/webhooks", { json: body }); setSecret({ title: t("secretTitle"), value: r.secret }); }
      setEdit(null); await hooks.reload();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const createKey = async () => {
    if (!newKey || !(await ensure())) return;
    setBusy(true); setErr(null);
    try { const r = await api<{ key: string }>("/api/api-keys", { json: { name: newKey.name, permissions: newKey.perms } }); setSecret({ title: t("keyCreated"), value: r.key }); setNewKey(null); await keys.reload(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const sendTest = async (h: Hook) => { try { const r = await api<{ status: string; statusCode?: number; error?: string }>(`/api/webhooks/${h.id}/test`, { method: "POST", json: {} }); toast(r.status === "SUCCESS" ? "ok" : "error", r.status === "SUCCESS" ? t("tested", { code: r.statusCode ?? 200 }) : t("testFailed", { error: r.error ?? r.status })); } catch (e) { toast("error", errMsg(e)); } };

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("sub")} />
      <section aria-labelledby="wh">
        <Card>
          <CardHeader title={<span id="wh" className="flex items-center gap-2"><Webhook className="size-4" aria-hidden />{t("webhooks")}</span>} description={t("webhooksSub")} action={<Button variant="primary" onClick={() => { setErr(null); setEdit({ url: "", events: hooks.data?.events.slice() ?? [], enabled: true }); }}><Plus className="size-4" aria-hidden />{t("addWebhook")}</Button>} />
          {hooks.loading && !hooks.data ? <div className="p-4"><Skeleton className="h-16" /></div> : !hooks.data?.items.length ? <EmptyState icon={<Webhook className="size-6" />} title={t("noWebhooks")} description={t("noWebhooksDesc")} /> : (
            <ul className="divide-y divide-line">{hooks.data.items.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="min-w-0 flex-1"><p className="truncate font-medium" dir="ltr">{h.url}</p><p className="mt-0.5 truncate text-xs text-muted">{h.events.map(evName).join(" · ")}</p></div>
                <Switch label={t("enabled")} checked={h.enabled} onChange={async (v) => { if (await ensure()) { try { await api(`/api/webhooks/${h.id}`, { method: "PATCH", json: { enabled: v } }); await hooks.reload(); } catch (e) { toast("error", errMsg(e)); } } }} />
                <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => sendTest(h)}><Send className="size-3.5" aria-hidden />{t("test")}</Button><Button size="sm" onClick={() => setDl(h)}>{t("deliveries")}</Button>
                  <Button size="sm" onClick={async () => { if (await ensure()) { const r = await api<{ secret: string }>(`/api/webhooks/${h.id}/rotate`, { method: "POST", json: {} }); setSecret({ title: t("rotated"), value: r.secret }); } }}><RefreshCw className="size-3.5" aria-hidden />{t("rotate")}</Button>
                  <Button size="sm" onClick={() => setEdit({ id: h.id, url: h.url, events: h.events, enabled: h.enabled })}>{c("edit")}</Button><Button size="sm" onClick={async () => { if (await ensure()) setDel(h); }} aria-label={c("delete")}><Trash2 className="size-3.5" /></Button></div>
              </li>))}</ul>)}
          <p className="border-t border-line px-5 py-3 text-xs text-muted">{t("docs")}</p>
        </Card>
      </section>
      <section aria-labelledby="ak">
        <Card>
          <CardHeader title={<span id="ak" className="flex items-center gap-2"><KeyRound className="size-4" aria-hidden />{t("apiKeys")}</span>} description={t("apiKeysSub")} action={<Button variant="primary" onClick={() => { setErr(null); setNewKey({ name: "", perms: ["contracts.view"] }); }}><Plus className="size-4" aria-hidden />{t("addKey")}</Button>} />
          {keys.loading && !keys.data ? <div className="p-4"><Skeleton className="h-16" /></div> : !keys.data?.keys.length ? <EmptyState icon={<KeyRound className="size-6" />} title={t("noKeys")} /> : (
            <TableWrap><Table><thead><tr><Th>{t("keyName")}</Th><Th>{t("prefix")}</Th><Th>{t("keyPerms")}</Th><Th>{t("lastUsed")}</Th><Th><span className="sr-only">{c("actions")}</span></Th></tr></thead>
              <tbody>{keys.data.keys.map((k) => <Tr key={k.id}><Td className="font-medium">{k.name}</Td><Td><code className="text-xs" dir="ltr">bes_live_{k.prefix}…</code></Td><Td className="max-w-xs truncate text-xs text-muted">{k.permissions.join(", ")}</Td><Td className="whitespace-nowrap text-muted">{k.lastUsedAt ? fmtDate(k.lastUsedAt, locale) : c("never")}</Td><Td className="text-end"><Button size="sm" onClick={async () => { if (await ensure()) setRevoke(k); }}>{t("revoke")}</Button></Td></Tr>)}</tbody></Table></TableWrap>)}
        </Card>
      </section>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? c("edit") : t("addWebhook")} size="lg" footer={<><Button onClick={() => setEdit(null)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!edit?.url || !edit?.events.length} onClick={saveHook}>{c("save")}</Button></>}>
        {edit && <div className="space-y-4"><Field label={t("url")} hint={t("urlHint")} error={err} required>{(p) => <Input {...p} type="url" dir="ltr" placeholder="https://example.com/hooks/esign" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />}</Field>
          <fieldset><legend className="mb-2 text-sm font-medium">{t("events")}</legend><div className="grid gap-2 sm:grid-cols-2">{hooks.data?.events.map((ev) => <Checkbox key={ev} label={evName(ev)} checked={edit.events.includes(ev)} onChange={(e) => setEdit({ ...edit, events: e.target.checked ? [...edit.events, ev] : edit.events.filter((x) => x !== ev) })} />)}</div></fieldset></div>}
      </Modal>
      <Modal open={!!newKey} onClose={() => setNewKey(null)} title={t("addKey")} footer={<><Button onClick={() => setNewKey(null)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!newKey?.name || !newKey?.perms.length} onClick={createKey}>{c("create")}</Button></>}>
        {newKey && <div className="space-y-4"><Field label={t("keyName")} error={err} required>{(p) => <Input {...p} value={newKey.name} onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} maxLength={80} />}</Field>
          <fieldset><legend className="mb-2 text-sm font-medium">{t("keyPerms")}</legend><div className="grid gap-2 sm:grid-cols-2">{KEY_PERMS.map((p) => <Checkbox key={p} label={<code className="text-xs">{p}</code>} checked={newKey.perms.includes(p)} onChange={(e) => setNewKey({ ...newKey, perms: e.target.checked ? [...newKey.perms, p] : newKey.perms.filter((x) => x !== p) })} />)}</div></fieldset></div>}
      </Modal>
      <Modal open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ""} size="md" footer={<Button variant="primary" onClick={() => setSecret(null)}>{c("done")}</Button>}>
        <Callout tone="warn" title={t("secretNote")} /><div className="mt-4 flex items-center gap-2"><code dir="ltr" className="min-w-0 flex-1 break-all rounded-lg bg-surface-2 p-3 text-sm">{secret?.value}</code><Button size="icon" aria-label={c("copy")} onClick={() => copy(secret!.value)}><Copy className="size-4" /></Button></div>
      </Modal>
      <Modal open={!!dl} onClose={() => setDl(null)} title={t("deliveries")} description={dl?.url} size="xl">
        {deliveries.loading && !deliveries.data ? <Skeleton className="h-32" /> : !deliveries.data?.items.length ? <p className="text-sm text-muted">{t("noDeliveries")}</p> : (
          <TableWrap><Table><thead><tr><Th>{c("date")}</Th><Th>{t("events")}</Th><Th>{c("statusLabel")}</Th><Th>HTTP</Th><Th><span className="sr-only">{c("actions")}</span></Th></tr></thead>
            <tbody>{deliveries.data.items.map((d) => <Tr key={d.id}><Td className="whitespace-nowrap text-muted">{fmtDate(d.createdAt, locale)}</Td><Td>{evName(d.event)}</Td><Td>{t.has(`deliveryStatus.${d.status}` as never) ? t(`deliveryStatus.${d.status}` as never) : d.status}<span className="block text-xs text-muted">{t("attempts", { n: d.attempts })}{d.lastError ? ` · ${d.lastError.slice(0, 80)}` : ""}</span></Td><Td className="num">{d.lastStatusCode ?? "—"}</Td>
              <Td className="text-end"><Button size="sm" onClick={async () => { try { await api(`/api/webhooks/deliveries/${d.id}/redeliver`, { method: "POST", json: {} }); toast("ok", t("redeliver")); await deliveries.reload(); } catch (e) { toast("error", errMsg(e)); } }}>{t("redeliver")}</Button></Td></Tr>)}</tbody></Table></TableWrap>)}
      </Modal>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={t("deleteTitle")} description={t("deleteDesc")} confirmLabel={c("delete")} onConfirm={async () => { await api(`/api/webhooks/${del!.id}`, { method: "DELETE" }); await hooks.reload(); }} />
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} title={t("revokeTitle")} description={t("revokeDesc")} confirmLabel={t("revoke")} onConfirm={async () => { await api(`/api/api-keys?id=${revoke!.id}`, { method: "DELETE" }); await keys.reload(); }} />
    </div>
  );
}
