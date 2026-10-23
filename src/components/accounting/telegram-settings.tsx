"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { KeyRound, Link2, MessageCircle, Play, Trash2 } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Badge } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, SwitchField } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type S = { enabled: boolean; voiceReplies: boolean; voiceForText: boolean; language: "auto" | "en" | "fa"; maxVoiceSec: number; maxFileMb: number; sessionMinutes: number; transcribeModel: string };
type Data = {
  settings: S; hasToken: boolean; tokenHint: string | null; botUsername: string | null; webhookUrl: string; webhookSetAt: string | null; webhookError: string | null;
  lastUpdateAt: string | null; lastVoiceInAt: string | null; lastVoiceOutAt: string | null; errors: Array<{ at: string; where: string; message: string }>;
  openAiReady: boolean; elevenReady: boolean;
  users: Array<{ id: string; telegramUserId: number; username: string | null; userName: string; email: string; lastSeenAt: string | null }>;
};

/** Finance settings → Telegram assistant: bot token, linking your Telegram, voice/text options, health. */
export function TelegramSettingsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("accounting.telegram");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { data, reload } = useApi<Data>("/api/accounting/settings/telegram");
  const [v, setV] = useState<S | null>(null);
  const [token, setToken] = useState(""); const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresAt: string; link: string | null } | null>(null);
  useEffect(() => { if (data && !v) setV(data.settings); }, [data, v]);
  // A newly linked account shows up without a refresh.
  useEffect(() => { if (!pair) return; const i = setInterval(() => void reload(), 5000); return () => clearInterval(i); }, [pair, reload]);
  if (!data || !v) return <Card id="telegram"><div className="p-5"><Skeleton className="h-40" /></div></Card>;
  const fmt = (d: string | null) => (d ? fmtDate(d, locale, { dateStyle: "short", timeStyle: "short" }) : t("never"));
  const run = async (what: string, f: () => Promise<unknown>) => { setBusy(what); setErr(null); try { await f(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); } };
  const save = (extra: Record<string, unknown> = {}) => run("save", async () => {
    if (extra.botToken && !(await ensure())) return;
    await api("/api/accounting/settings/telegram", { method: "PATCH", json: { ...v, ...extra } });
    setToken(""); toast("ok", t("saved")); await reload();
  });
  const set = (p: Partial<S>) => setV({ ...v, ...p });
  return (
    <Card id="telegram" className="scroll-mt-24">
      <CardHeader title={<span className="flex items-center gap-2"><MessageCircle className="size-5" aria-hidden />{t("title")}</span>} description={t("desc")}
        action={<Badge s={!data.hasToken ? "DISCONNECTED" : data.webhookError ? "FAILED" : v.enabled ? "CONNECTED" : "INACTIVE"} />} />
      <div className="space-y-6 p-5">
        {/* Bot */}
        <section className="space-y-3">
          <p className="text-sm font-semibold">{t("bot")}</p>
          {data.hasToken && <p className="text-sm">{data.botUsername ? <a className="font-medium underline underline-offset-4" href={`https://t.me/${data.botUsername}`} target="_blank" rel="noreferrer">@{data.botUsername}</a> : t("bot")} <span className="text-muted">· {t("token")} {data.tokenHint}</span></p>}
          {data.webhookError && <Callout tone="warn" title={t("webhookFailed")}>{data.webhookError}</Callout>}
          {admin && <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1"><Field label={data.hasToken ? t("replaceToken") : t("tokenLabel")} hint={t("tokenHint")}>{(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="123456789:AA…" className="font-mono" />}</Field></div>
            <Button variant="primary" loading={busy === "save" && !!token} disabled={token.length < 20} onClick={() => save({ botToken: token })}><KeyRound className="size-4" aria-hidden />{t("saveToken")}</Button>
          </div>}
        </section>

        {/* Linking */}
        {data.hasToken && <section className="space-y-3">
          <p className="text-sm font-semibold">{t("accounts")}</p>
          {pair ? (
            <div className="space-y-2 rounded-xl border border-accent bg-accent-soft p-4 text-sm">
              <p>{t("sendThis")}</p>
              <p className="num select-all text-2xl font-semibold tracking-widest">/link {pair.code}</p>
              {pair.link && <a className="inline-block underline underline-offset-4" href={pair.link} target="_blank" rel="noreferrer">{t("openBot")}</a>}
              <p className="text-xs text-muted">{t("codeExpires", { when: fmt(pair.expiresAt) })}</p>
            </div>
          ) : <Button onClick={() => run("pair", async () => { if (!(await ensure())) return; setPair(await api("/api/accounting/settings/telegram/pairing", { method: "POST" })); })} loading={busy === "pair"}><Link2 className="size-4" aria-hidden />{t("linkMine")}</Button>}
          {!data.users.length ? <p className="text-sm text-muted">{t("noAccounts")}</p> : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {data.users.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="font-medium">{u.username ? `@${u.username}` : `#${u.telegramUserId}`}</span>
                  <span className="text-muted">{u.userName}</span>
                  <span className="text-xs text-muted">{t("lastUsed", { when: fmt(u.lastSeenAt) })}</span>
                  {admin && <Button size="sm" variant="ghost" className="ms-auto" onClick={() => run(`rm${u.id}`, async () => { await api(`/api/accounting/settings/telegram/users/${u.id}`, { method: "DELETE" }); toast("ok", t("unlinked")); await reload(); })}><Trash2 className="size-3.5" aria-hidden />{t("unlink")}</Button>}
                </li>
              ))}
            </ul>
          )}
        </section>}

        {/* Options */}
        <section className="space-y-3">
          <p className="text-sm font-semibold">{t("options")}</p>
          <SwitchField label={t("enabled")} checked={v.enabled} disabled={!admin} onChange={(x) => set({ enabled: x })} />
          <SwitchField label={t("voiceReplies")} checked={v.voiceReplies} disabled={!admin} onChange={(x) => set({ voiceReplies: x })} />
          <SwitchField label={t("voiceForText")} checked={v.voiceForText} disabled={!admin} onChange={(x) => set({ voiceForText: x })} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("language")}>{(p) => <Select {...p} disabled={!admin} value={v.language} onChange={(e) => set({ language: e.target.value as S["language"] })}><option value="auto">{t("lang.auto")}</option><option value="fa">{t("lang.fa")}</option><option value="en">{t("lang.en")}</option></Select>}</Field>
            <Field label={t("maxVoice")}>{(p) => <Input {...p} type="number" min={10} max={600} disabled={!admin} value={v.maxVoiceSec} onChange={(e) => set({ maxVoiceSec: Number(e.target.value) })} />}</Field>
            <Field label={t("maxFile")}>{(p) => <Input {...p} type="number" min={1} max={20} disabled={!admin} value={v.maxFileMb} onChange={(e) => set({ maxFileMb: Number(e.target.value) })} />}</Field>
            <Field label={t("session")}>{(p) => <Input {...p} type="number" min={5} max={10080} disabled={!admin} value={v.sessionMinutes} onChange={(e) => set({ sessionMinutes: Number(e.target.value) })} />}</Field>
          </div>
          {admin && <Button onClick={() => save()} loading={busy === "save" && !token}>{t("save")}</Button>}
        </section>

        {/* Health */}
        <section className="space-y-2 text-sm">
          <p className="font-semibold">{t("health")}</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            <li>{t("openAi")}: <span className={data.openAiReady ? "text-fin-pos" : "text-fin-warn"}>{data.openAiReady ? t("ready") : t("missing")}</span></li>
            <li>{t("eleven")}: <span className={data.elevenReady ? "text-fin-pos" : "text-fin-warn"}>{data.elevenReady ? t("ready") : t("missing")}</span></li>
            <li>{t("lastMessage")}: {fmt(data.lastUpdateAt)}</li>
            <li>{t("lastVoiceIn")}: {fmt(data.lastVoiceInAt)}</li>
            <li>{t("lastVoiceOut")}: {fmt(data.lastVoiceOutAt)}</li>
            <li>{t("webhook")}: {data.webhookSetAt ? fmt(data.webhookSetAt) : t("never")}</li>
          </ul>
          {admin && data.users.length > 0 && <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" loading={busy === "en"} onClick={() => run("en", async () => { await api("/api/accounting/settings/telegram/test", { method: "POST" }); toast("ok", t("testSent")); await reload(); })}><Play className="size-3.5" aria-hidden />{t("testVoice")}</Button>
            <Button size="sm" loading={busy === "fa"} onClick={() => run("fa", async () => { await api("/api/accounting/settings/telegram/test?lang=fa", { method: "POST" }); toast("ok", t("testSent")); await reload(); })}><Play className="size-3.5" aria-hidden />{t("testVoiceFa")}</Button>
          </div>}
          {data.errors.length > 0 && <details className="rounded-xl border border-line p-3"><summary className="cursor-pointer">{t("errors", { n: data.errors.length })}</summary>
            <ul className="mt-2 space-y-1 text-xs text-muted">{data.errors.map((e, i) => <li key={i}><span className="num">{fmt(e.at)}</span> · {e.where} · {e.message}</li>)}</ul></details>}
        </section>
        {err && <Callout tone="warn">{err}</Callout>}
        <Callout title={t("howTitle")}>{t("how")}</Callout>
      </div>
    </Card>
  );
}
