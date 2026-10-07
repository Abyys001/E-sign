"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Copy, Download, Landmark, Unplug } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Money } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { cn } from "@/components/ui/cn";

type Balance = { id: string; currency: string; amount: number };
type Status = { connected: false } | { connected: true; tokenHint: string | null; profileName: string | null; publicKey: string | null; balances: Balance[]; status: string; statementsOk: boolean; lastSyncAt: string | null; lastError: string | null };

const MAIN = ["gbp", "eur", "usd", "sek", "dkk", "nok", "cad", "aed"];

/** One card per currency (Wise can hold several balances — "jars" — in the same currency; they are added up). */
export function WiseBalances({ balances }: { balances: Balance[] }) {
  const t = useTranslations("accounting.wise");
  const [showEmpty, setShowEmpty] = useState(false);
  const by = new Map<string, { amount: number; n: number }>();
  for (const b of balances) { const x = by.get(b.currency) ?? { amount: 0, n: 0 }; x.amount += b.amount; x.n++; by.set(b.currency, x); }
  const rank = (c: string) => { const i = MAIN.indexOf(c); return i < 0 ? 99 : i; };
  const all = [...by.entries()].map(([currency, x]) => ({ currency, ...x })).sort((a, b) => Number(b.amount > 0) - Number(a.amount > 0) || rank(a.currency) - rank(b.currency) || a.currency.localeCompare(b.currency));
  const filled = all.filter((x) => x.amount !== 0), empty = all.filter((x) => x.amount === 0);
  const shown = showEmpty ? all : filled;
  if (!all.length) return null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {shown.map((b) => (
          <div key={b.currency} className={cn("relative overflow-hidden rounded-card border p-4 shadow-card", b.amount > 0 ? "border-fin-bal/30 bg-fin-bal/10" : "border-line bg-surface")}>
            <span aria-hidden className={cn("absolute inset-y-0 start-0 w-1", b.amount > 0 ? "bg-fin-bal" : "bg-line-strong")} />
            <div className="flex items-center justify-between gap-2">
              <span className={cn("rounded-md px-2 py-0.5 font-mono text-xs font-semibold tracking-wider", b.amount > 0 ? "bg-fin-bal/15 text-fin-bal" : "bg-surface-2 text-muted")}>{b.currency.toUpperCase()}</span>
              {b.n > 1 && <span className="text-[11px] text-muted">{t("jars", { n: b.n })}</span>}
            </div>
            <div className={cn("num mt-2 truncate text-2xl font-semibold tracking-tight", b.amount === 0 && "text-muted")}><Money v={b.amount} c={b.currency} /></div>
          </div>
        ))}
      </div>
      {empty.length > 0 && <button type="button" className="text-xs text-muted underline underline-offset-4 hover:text-fg" onClick={() => setShowEmpty(!showEmpty)}>{showEmpty ? t("hideEmpty") : t("showEmpty", { n: empty.length })}</button>}
    </div>
  );
}

/** Finance settings → Wise: connection details, disconnect, and the optional statement (SCA) public key. */
export function WiseSettingsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("accounting.wise");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { data: s, reload } = useApi<Status>("/api/accounting/wise");
  const [disc, setDisc] = useState(false);
  if (!s) return null;
  const download = (k: string) => { const u = URL.createObjectURL(new Blob([k], { type: "application/x-pem-file" })); const a = document.createElement("a"); a.href = u; a.download = "bilit-wise-public-key.pem"; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
  const copy = async (k: string) => { try { await navigator.clipboard.writeText(k); toast("ok", t("copied")); } catch { toast("error", t("copyFailed")); } };
  return (
    <Card>
      <CardHeader title={t("settingsTitle")} description={s.connected ? t("connInfo", { hint: s.tokenHint ?? "—", when: s.lastSyncAt ? fmtDate(s.lastSyncAt, locale, { dateStyle: "medium", timeStyle: "short" }) : t("never") }) : t("settingsNotConnected")}
        action={s.connected && admin ? <Button size="sm" variant="ghost" onClick={async () => { if (await ensure()) setDisc(true); }}><Unplug className="size-4" aria-hidden />{t("disconnect")}</Button> : <Link href="/accounting/wise" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-surface-2"><Landmark className="size-4" aria-hidden />{t("title")}</Link>} />
      {s.connected && <div className="space-y-3 p-5 text-sm">
        <p><span className="text-muted">{t("profile")}:</span> <span className="font-medium">{s.profileName}</span></p>
        {s.statementsOk ? <p className="text-muted">{t("scaOk")}</p> : s.publicKey && <div className="space-y-2 rounded-xl border border-line-strong bg-surface-2 p-4">
          <p className="font-medium">{t("scaTitle")}</p>
          <p className="text-muted">{t("scaDesc")}</p>
          <pre className="scroll-thin max-h-32 overflow-auto rounded-lg bg-surface p-3 font-mono text-[11px] leading-snug">{s.publicKey}</pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => download(s.publicKey!)}><Download className="size-4" aria-hidden />{t("downloadKey")}</Button>
            <Button size="sm" onClick={() => void copy(s.publicKey!)}><Copy className="size-4" aria-hidden />{t("copyKey")}</Button>
          </div>
          {s.lastError && <p className="text-xs text-muted">{t("lastStatementError")}: {s.lastError}</p>}
        </div>}
      </div>}
      <ConfirmDialog open={disc} onClose={() => setDisc(false)} title={t("disconnectTitle")} description={t("disconnectDesc")} confirmLabel={t("disconnect")}
        onConfirm={async () => { try { await api("/api/accounting/wise", { method: "DELETE" }); toast("ok", t("disconnected")); await reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }} />
    </Card>
  );
}
