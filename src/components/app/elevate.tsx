"use client";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { api, errMsg } from "@/lib/api";
import { useMe } from "./me";

const Ctx = createContext<{ ensure: () => Promise<boolean> }>({ ensure: async () => true });
export const useElevation = () => useContext(Ctx).ensure;

/** Re-authentication gate. Call `await ensure()` before a sensitive request; resolves true once the server accepted the check. */
export function ElevationProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("app.elevate");
  const c = useTranslations("common");
  const { me, reload } = useMe();
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiter = useRef<((ok: boolean) => void) | null>(null);
  const ensure = useCallback(() => (me.elevated ? Promise.resolve(true) : new Promise<boolean>((res) => { waiter.current = res; setVal(""); setErr(null); setOpen(true); })), [me.elevated]);
  const finish = (ok: boolean) => { setOpen(false); waiter.current?.(ok); waiter.current = null; };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api("/api/auth/elevate", { json: me.user.hasTotp ? { totp: val } : { password: val } }); await reload(); finish(true); }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <Ctx.Provider value={{ ensure }}>
      {children}
      <Modal open={open} onClose={() => finish(false)} title={t("title")} description={t("desc")} size="sm">
        <form onSubmit={submit} className="space-y-4">
          <Field label={me.user.hasTotp ? t("totp") : t("password")} error={err}>
            {(p) => <Input {...p} autoFocus autoComplete={me.user.hasTotp ? "one-time-code" : "current-password"} inputMode={me.user.hasTotp ? "numeric" : undefined} type={me.user.hasTotp ? "text" : "password"} value={val} onChange={(e) => setVal(e.target.value)} />}
          </Field>
          <div className="flex justify-end gap-2"><Button onClick={() => finish(false)}>{c("cancel")}</Button><Button type="submit" variant="primary" loading={busy} disabled={!val}>{t("confirm")}</Button></div>
        </form>
      </Modal>
    </Ctx.Provider>
  );
}
