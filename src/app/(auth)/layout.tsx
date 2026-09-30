import { CheckCircle2, ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/ui/logo";
import { LocaleSwitch } from "@/components/app/locale-switch";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("auth");
  const points = t.raw("points") as string[];
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-[var(--color-12)] p-12 text-[var(--color-1)] lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden className="absolute -end-32 -top-32 size-[28rem] rounded-full bg-[var(--color-5)] opacity-[.12] blur-3xl" />
        <div aria-hidden className="absolute -bottom-40 -start-24 size-[26rem] rounded-full bg-[var(--color-5)] opacity-[.08] blur-3xl" />
        <Logo height={44} className="relative" />
        <div className="relative max-w-lg">
          <ShieldCheck className="mb-6 size-10 text-[var(--color-5)]" aria-hidden />
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">{t("hero")}</h2>
          <p className="mt-4 text-lg text-[var(--color-2)]">{t("heroSub")}</p>
          <ul className="mt-8 space-y-3">{points.map((p) => <li key={p} className="flex items-start gap-3 text-[var(--color-1)]"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[var(--color-5)]" aria-hidden />{p}</li>)}</ul>
        </div>
        <p className="relative text-sm text-[var(--color-2)]">© Bilit.event E-Sign</p>
      </section>
      <main className="relative flex items-center justify-center px-5 py-12">
        <div className="absolute end-4 top-4"><LocaleSwitch /></div>
        <div className="w-full max-w-md">
          <div className="mb-8 rounded-2xl bg-[var(--color-12)] p-4 lg:hidden"><Logo height={34} /></div>
          {children}
        </div>
      </main>
    </div>
  );
}
