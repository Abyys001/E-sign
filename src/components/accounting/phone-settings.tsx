"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { QrCode, Smartphone } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Callout } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type Device = { id: string; name: string; userName: string; mine: boolean; createdAt: string; lastUnlockAt: string | null };
type Pairing = { url: string; svg: string; expiresAt: string };

/** Finance settings → Phone app: one-time QR code that sets up Bilit Phone, and the phones already set up. */
export function PhoneSettingsCard() {
  const t = useTranslations("accounting.phone.settings");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { data, reload } = useApi<{ devices: Device[] }>("/api/accounting/phone/devices");
  const [pair, setPair] = useState<Pairing | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!pair) return;
    const tick = () => { const s = Math.max(0, Math.round((new Date(pair.expiresAt).getTime() - Date.now()) / 1000)); setLeft(s); if (!s) setPair(null); };
    tick(); const i = setInterval(tick, 1000); return () => clearInterval(i);
  }, [pair]);
  // A phone that pairs shows up here without a refresh.
  useEffect(() => { if (!pair) return; const i = setInterval(() => void reload(), 5000); return () => clearInterval(i); }, [pair, reload]);

  const show = async () => {
    setBusy(true); setErr(null);
    try { if (!(await ensure())) return; setPair(await api<Pairing>("/api/accounting/phone/pairing", { method: "POST" })); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const signOut = async (id: string) => {
    try { await api(`/api/accounting/phone/devices/${id}`, { method: "DELETE" }); toast("ok", t("signedOut")); await reload(); }
    catch (e) { setErr(errMsg(e)); }
  };
  return (
    <Card id="phone" className="scroll-mt-24"><CardHeader title={<span className="flex items-center gap-2"><Smartphone className="size-5" aria-hidden />{t("title")}</span>} description={t("desc")} />
      <div className="space-y-4 p-5">
        {pair ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line p-5 text-center">
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(pair.svg)}`} alt={t("show")} className="size-60 rounded-lg bg-white p-2" />
            <p className="text-sm">{t("expires")} <span className="num font-semibold">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span></p>
            <p className="max-w-md text-xs text-muted">{t("install")}</p>
            <div className="flex gap-2"><Button size="sm" onClick={show} loading={busy}>{t("newCode")}</Button><Button size="sm" variant="ghost" onClick={() => setPair(null)}>{t("hide")}</Button></div>
          </div>
        ) : <Button variant="primary" onClick={show} loading={busy}><QrCode className="size-4" aria-hidden />{t("show")}</Button>}
        {err && <Callout tone="warn">{err}</Callout>}
        <div>
          <p className="mb-2 text-sm font-semibold">{t("devices")}</p>
          {!data?.devices.length ? <p className="text-sm text-muted">{t("none")}</p> : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {data.devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <Smartphone className="size-4 text-muted" aria-hidden />
                  <span className="font-medium">{d.name}</span>
                  <span className="text-muted">{d.mine ? t("you") : d.userName}</span>
                  <span className="text-xs text-muted">{t("lastUsed", { when: d.lastUnlockAt ? fmtDate(d.lastUnlockAt, locale) : t("never") })}</span>
                  <Button size="sm" variant="ghost" className="ms-auto" onClick={() => signOut(d.id)}>{t("signOut")}</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
