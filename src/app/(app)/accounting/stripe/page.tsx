"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { KeyRound, Lock, PlugZap, RefreshCw, Unplug, Webhook } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Badge, CopyText, DL, useMode } from "@/components/accounting/kit";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { StripeNav } from "./nav";

type ModeView = { mode: "test" | "live"; connected: boolean; status: string; stripeAccountId?: string | null; displayName?: string | null; keyHint?: string | null; webhookConfigured?: boolean; webhookSecretHint?: string | null; webhookEndpointId?: string | null; lastTestedAt?: string | null; lastError?: string | null; lastSyncAt?: string | null; lastWebhookAt?: string | null; lastWebhookType?: string | null; webhook: { total: number; failed: number; last: string | null; last_type: string | null } | null };
type S = { webhookUrl: string; events: string[]; modes: ModeView[] };
type Ev = { id: string; eventId: string; type: string; objectId: string | null; status: string; attempts: number; error: string | null; receivedAt: string };

export default function StripePage() {
  const t = useTranslations("accounting.stripe");
  const locale = useLocale();
  const { mode, q } = useMode();
  const { can } = useMe();
  const { data, reload } = useApi<S>("/api/accounting/stripe");
  const [evPage, setEvPage] = useState(1);
  const events = useApi<{ items: Ev[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/stripe/events?page=${evPage}&pageSize=20`));
  const m = data?.modes.find((x) => x.mode === mode);
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <StripeNav />
      {!data || !m ? <Skeleton className="h-64" /> : <div className="space-y-6">
        <ConnectionCard m={m} admin={can("accounting.admin")} onChange={reload} />
        <Card><CardHeader title={<span className="flex items-center gap-2"><Webhook className="size-4" aria-hidden />{t("webhook.title")}</span>} description={t("webhook.desc")} />
          <div className="space-y-5 p-5">
            <DL items={[
              [t("webhook.endpoint"), <CopyText key="u" text={data.webhookUrl} />],
              [t("webhook.status"), !m.webhookConfigured ? <Badge key="s" s="DISCONNECTED" /> : m.webhook && m.webhook.failed > 0 ? <span key="s" className="flex items-center gap-2"><Badge s="FAILED" />{t("webhook.failures", { n: m.webhook.failed })}</span> : <Badge key="s" s="CONNECTED" />],
              [t("webhook.secret"), m.webhookSecretHint], [t("webhook.endpointId"), m.webhookEndpointId],
              [t("webhook.last"), m.lastWebhookAt ? `${fmtDate(m.lastWebhookAt, locale)} · ${m.lastWebhookType}` : t("never")],
              [t("webhook.events"), <span key="e" className="text-xs text-muted">{data.events.join(", ")}</span>],
            ]} />
            {can("accounting.admin") && m.connected && <WebhookSetup mode={mode} url={data.webhookUrl} onChange={reload} />}
            <Callout title={t("cli.title")}><p className="text-sm">{t("cli.desc")}</p><pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">{`stripe login\nstripe listen --forward-to http://localhost:3000/api/webhooks/stripe\n# paste the printed whsec_… below (test mode)\nstripe trigger payment_intent.succeeded`}</pre></Callout>
          </div>
        </Card>
        <Card><CardHeader title={t("log.title")} description={t("log.desc")} />
          {!events.data?.items.length ? <p className="px-5 py-6 text-sm text-muted">{t("log.empty")}</p> : <>
            <TableWrap><Table><thead><tr><Th>{t("log.received")}</Th><Th>{t("log.type")}</Th><Th>{t("log.object")}</Th><Th>{t("log.status")}</Th><Th>{t("log.attempts")}</Th></tr></thead>
              <tbody>{events.data.items.map((e) => <Tr key={e.id}><Td className="whitespace-nowrap text-muted">{fmtDate(e.receivedAt, locale, { dateStyle: "short", timeStyle: "medium" })}</Td><Td><code className="text-xs">{e.type}</code></Td><Td><code className="text-xs">{e.objectId}</code></Td><Td><Badge s={e.status} />{e.error && <span className="block max-w-72 truncate text-xs text-muted" title={e.error}>{e.error}</span>}</Td><Td className="num">{e.attempts}</Td></Tr>)}</tbody></Table></TableWrap>
            <Pagination page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={setEvPage} /></>}
        </Card>
        <Callout icon={<Lock className="mt-0.5 size-4 shrink-0" aria-hidden />} title={t("security.title")}>{t("security.desc")}</Callout>
      </div>}
    </div>
  );
}

function ConnectionCard({ m, admin, onChange }: { m: ModeView; admin: boolean; onChange: () => void }) {
  const t = useTranslations("accounting.stripe");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const [open, setOpen] = useState(false); const [key, setKey] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [disc, setDisc] = useState(false); const [testing, setTesting] = useState(false);
  const save = async () => { setBusy(true); setErr(null); try { await api("/api/accounting/stripe/connect", { json: { mode: m.mode, secretKey: key } }); setKey(""); setOpen(false); toast("ok", t("conn.connected")); onChange(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const test = async () => { setTesting(true); try { const r = await api<{ ok: boolean; error?: string }>("/api/accounting/stripe/test", { json: { mode: m.mode } }); toast(r.ok ? "ok" : "error", r.ok ? t("conn.testOk") : r.error ?? t("conn.testFail")); onChange(); } catch (e) { toast("error", errMsg(e)); } finally { setTesting(false); } };
  return (
    <Card><CardHeader title={<span className="flex items-center gap-2"><PlugZap className="size-4" aria-hidden />{t("conn.title", { mode: m.mode.toUpperCase() })}</span>} description={t("conn.desc")}
      action={<Badge s={m.connected ? m.status : "DISCONNECTED"} />} />
      <div className="space-y-5 p-5">
        <DL items={[
          [t("conn.account"), m.stripeAccountId ? `${m.stripeAccountId}${m.displayName ? ` · ${m.displayName}` : ""}` : null], [t("conn.mode"), <span key="m" className="font-semibold uppercase">{m.mode}</span>],
          [t("conn.key"), m.keyHint], [t("conn.lastTest"), m.lastTestedAt ? fmtDate(m.lastTestedAt, locale) : null], [t("conn.lastSync"), m.lastSyncAt ? fmtDate(m.lastSyncAt, locale) : t("never")],
          [t("conn.error"), m.lastError],
        ]} />
        {admin && <div className="flex flex-wrap gap-2">
          <Button variant={m.connected ? "secondary" : "primary"} onClick={async () => { if (await ensure()) setOpen(true); }}><KeyRound className="size-4" aria-hidden />{m.connected ? t("conn.replace") : t("conn.connect")}</Button>
          {m.connected && <><Button loading={testing} onClick={test}><RefreshCw className="size-4" aria-hidden />{t("conn.test")}</Button><LinkButton href="/accounting/stripe/sync">{t("conn.sync")}</LinkButton>
            <Button variant="ghost" onClick={async () => { if (await ensure()) setDisc(true); }}><Unplug className="size-4" aria-hidden />{t("conn.disconnect")}</Button></>}
        </div>}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={t("conn.keyTitle", { mode: m.mode.toUpperCase() })} description={t("conn.keyDesc")}
        footer={<><Button onClick={() => setOpen(false)}>{t("cancel")}</Button><Button variant="primary" loading={busy} disabled={key.length < 10} onClick={save}>{t("conn.save")}</Button></>}>
        <div className="space-y-4">
          <Field label={t("conn.keyLabel")} hint={t("conn.keyHint", { prefix: m.mode === "live" ? "rk_live_" : "rk_test_" })}>{(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value.trim())} className="font-mono" />}</Field>
          <Callout title={t("conn.permsTitle")}>{t("conn.perms")}</Callout>
          {err && <Callout tone="warn">{err}</Callout>}
        </div>
      </Modal>
      <ConfirmDialog open={disc} onClose={() => setDisc(false)} title={t("conn.disconnectTitle")} description={t("conn.disconnectDesc")} confirmLabel={t("conn.disconnect")}
        onConfirm={async () => { await api("/api/accounting/stripe/disconnect", { json: { mode: m.mode } }); toast("ok", t("conn.disconnected")); onChange(); }} />
    </Card>
  );
}

function WebhookSetup({ mode, url, onChange }: { mode: string; url: string; onChange: () => void }) {
  const t = useTranslations("accounting.stripe.webhook");
  const toast = useToast();
  const ensure = useElevation();
  const [secret, setSecret] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  const run = async (what: "auto" | "secret") => {
    if (!(await ensure())) return;
    setBusy(what);
    try {
      if (what === "auto") await api("/api/accounting/stripe/register-webhook", { json: { mode } });
      else { await api("/api/accounting/stripe/webhook-secret", { json: { mode, secret } }); setSecret(""); }
      toast("ok", t("saved")); onChange();
    } catch (e) { toast("error", errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <div className="grid gap-4 rounded-xl border border-line p-4 lg:grid-cols-2">
      <div className="space-y-2"><p className="text-sm font-medium">{t("autoTitle")}</p><p className="text-xs text-muted">{t("autoDesc", { url })}</p><Button size="sm" loading={busy === "auto"} disabled={!url.startsWith("https://")} onClick={() => run("auto")}>{t("auto")}</Button></div>
      <div className="space-y-2"><Field label={t("manualTitle")} hint={t("manualDesc")}>{(p) => <Input {...p} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value.trim())} placeholder="whsec_…" className="font-mono" />}</Field><Button size="sm" loading={busy === "secret"} disabled={!secret.startsWith("whsec_")} onClick={() => run("secret")}>{t("saveSecret")}</Button></div>
    </div>
  );
}
