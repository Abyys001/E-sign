"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";

export type Me = {
  user: { id: string; email: string; name: string; locale: string; isSuperAdmin: boolean; hasTotp: boolean };
  csrfToken: string;
  organisations: Array<{ id: string; name: string; roleKey?: string }>;
  activeOrganisationId: string;
  branding: { orgName: string; logoObjectId: string | null; primaryColor: string | null; supportEmail: string };
  roleKey: string;
  permissions: string[];
  elevated: boolean;
  settings: { general: { timezone: string; defaultLocale: string }; signing: { allowTyped: boolean; allowDrawn: boolean; allowUploaded: boolean; defaultExpiryDays: number; defaultAuthLevel: string; defaultSigningOrder: string }; sms: { enabled: boolean } };
};
const Ctx = createContext<{ me: Me; can: (p: string) => boolean; reload: () => Promise<void> } | null>(null);
export const useMe = () => { const v = useContext(Ctx); if (!v) throw new Error("useMe outside MeProvider"); return v; };

export function MeProvider({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const reload = useCallback(async () => { try { setMe(await api<Me>("/api/auth/me")); } catch { window.location.href = "/login"; } }, []);
  useEffect(() => { void reload(); }, [reload]);
  if (!me) return <>{fallback}</>;
  return <Ctx.Provider value={{ me, can: (p) => me.permissions.includes(p) || me.user.isSuperAdmin, reload }}>{children}</Ctx.Provider>;
}
