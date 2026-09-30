"use client";
import { use, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { BadgeCheck, FileSearch, ShieldAlert, ShieldCheck } from "lucide-react";
import { LocaleSwitch } from "@/components/app/locale-switch";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { Logo } from "@/components/ui/logo";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type Rec = { verified: boolean; organisation: string; contractName: string; reference: string; completedAt: string | null; certificateId: string | null; finalDocumentHash: string; auditChainIntact: boolean; signers: Array<{ name: string; signedAt: string | null }> };

async function sha256Hex(file: File) {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function VerifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("verify");
  const locale = useLocale();
  const { data, error, loading } = useApi<Rec>(`/api/verify/${encodeURIComponent(id)}`);
  const [res, setRes] = useState<{ hash: string; match: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const check = async (f: File | undefined) => {
    if (!f) return; setBusy(true); setErr(null); setRes(null);
    try { const hash = await sha256Hex(f); const r = await api<{ match: boolean }>(`/api/verify/${encodeURIComponent(id)}`, { json: { hash } }); setRes({ hash, match: r.match }); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="min-h-dvh">
      <header className="bg-[var(--color-12)]"><div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3"><Logo height={32} /><LocaleSwitch onDark /></div></header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1><p className="mt-2 text-muted">{t("sub")}</p>
        <div className="mt-8 space-y-6">
          {loading && <Skeleton className="h-64" />}
          {error && <Callout tone="warn" title={t("notFound")} icon={<ShieldAlert className="size-5 shrink-0" />} />}
          {data && (<>
            <Card className="rise p-6">
              <div className="mb-5 flex items-center gap-3"><span className="grid size-11 place-items-center rounded-full bg-accent text-accent-fg"><BadgeCheck className="size-6" aria-hidden /></span><h2 className="text-lg font-semibold">{t("valid")}</h2></div>
              <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
                <Item k={t("contract")} v={data.contractName} /><Item k={t("org")} v={data.organisation} /><Item k={t("reference")} v={<span className="num">{data.reference}</span>} /><Item k={t("completed")} v={fmtDate(data.completedAt, locale)} />
                {data.certificateId && <Item k={t("certificate")} v={<span className="num">{data.certificateId}</span>} />}
                <Item k={t("chain")} v={<span className="inline-flex items-center gap-1.5">{data.auditChainIntact ? <ShieldCheck className="size-4" aria-hidden /> : <ShieldAlert className="size-4" aria-hidden />}{data.auditChainIntact ? t("chainOk") : t("chainBad")}</span>} />
                <div className="sm:col-span-2"><Item k={t("hash")} v={<code className="break-all text-xs">{data.finalDocumentHash}</code>} /></div>
                <div className="sm:col-span-2"><dt className="text-muted">{t("signers")}</dt><dd className="mt-1 space-y-1">{data.signers.map((s, i) => <p key={i} className="flex justify-between gap-3"><span className="font-medium">{s.name}</span><span className="text-muted">{fmtDate(s.signedAt, locale)}</span></p>)}</dd></div>
              </dl>
            </Card>
            <Card className="p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold"><FileSearch className="size-5" aria-hidden />{t("check")}</h2><p className="mt-1 text-sm text-muted">{t("checkDesc")}</p>
              <label className="mt-4 inline-flex h-11 cursor-pointer items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-fg hover:brightness-95"><input type="file" accept="application/pdf" className="sr-only" onChange={(e) => check(e.target.files?.[0])} />{busy ? t("computing") : t("choose")}</label>
              {err && <p role="alert" className="mt-3 text-sm">⚠ {err}</p>}
              {res && <div className="mt-4 space-y-2"><Callout tone={res.match ? "ok" : "warn"} icon={res.match ? <BadgeCheck className="size-5 shrink-0" /> : <ShieldAlert className="size-5 shrink-0" />} title={res.match ? t("match") : t("mismatch")} /><p className="text-xs text-muted">{t("yourHash")}: <code className="break-all">{res.hash}</code></p></div>}
            </Card>
          </>)}
          <p className="text-xs text-muted">{t("note")}</p>
        </div>
      </main>
    </div>
  );
}
const Item = ({ k, v }: { k: string; v: React.ReactNode }) => <div><dt className="text-muted">{k}</dt><dd className="mt-0.5 font-medium">{v}</dd></div>;
