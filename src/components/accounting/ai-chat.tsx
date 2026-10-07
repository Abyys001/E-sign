"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bot, Check, CheckCircle2, Loader2, MessageCircle, Search, Send, Trash2, X } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { api, errMsg, useApi } from "@/lib/api";

type Proposal = { id: string; summary: string; action: Record<string, unknown> & { kind: string }; needsElevation: boolean; state?: "done" | "dismissed" | "error" | "busy"; note?: string };
type Msg = { role: "user" | "assistant"; content: string; error?: boolean; steps?: string[]; proposals?: Proposal[] };
const KEY = "bilit.finance.aichat";
const load = (): Msg[] => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Msg[]; } catch { return []; } };
const save = (m: Msg[]) => { try { sessionStorage.setItem(KEY, JSON.stringify(m.slice(-40))); } catch { /* storage may be unavailable */ } };

/** Minimal, safe rendering of the model's answer: paragraphs, bullet lists, **bold**, and markdown tables as monospace. */
function Answer({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <Fragment key={i}>{p.replace(/`([^`]+)`/g, "$1")}</Fragment>));
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*\|/.test(l)) { const t: string[] = []; while (i < lines.length && /^\s*\|/.test(lines[i]!)) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i]!)) t.push(lines[i]!.trim()); i++; } i--; blocks.push(<pre key={i} className="scroll-thin overflow-x-auto rounded-lg bg-surface-2 p-2 text-[11px] leading-snug">{t.map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join("  ·  ")).join("\n")}</pre>); continue; }
    if (/^\s*([-*•]|\d+\.)\s+/.test(l)) { const items: string[] = []; while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*([-*•]|\d+\.)\s+/, "")); i++; } i--; blocks.push(<ul key={i} className="list-disc space-y-0.5 ps-5">{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>); continue; }
    if (/^#{1,4}\s/.test(l)) { blocks.push(<p key={i} className="font-semibold">{inline(l.replace(/^#+\s/, ""))}</p>); continue; }
    if (l.trim()) blocks.push(<p key={i}>{inline(l)}</p>);
  }
  return <div className="space-y-2">{blocks}</div>;
}

/** Chat with the AI finance assistant about payments, profits, refunds and settlement (uses the live ledger figures). */
export function ChatPanel({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("accounting.aichat");
  const { q } = useMode();
  const ai = useApi<{ enabled: boolean; hasKey: boolean; model: string }>("/api/accounting/settings/ai");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState(""); const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // Restore the conversation after mount (not during server render), then keep it in this tab's session storage.
  useEffect(() => { setMsgs(load()); setLoaded(true); }, []);
  useEffect(() => { if (loaded) save(msgs); end.current?.scrollIntoView({ block: "end" }); }, [msgs, loaded]);
  const ensure = useElevation();
  const { can } = useMe();
  const ask = async (question: string) => {
    const qn = question.trim(); if (!qn || busy) return;
    const next = [...msgs.filter((m) => !m.error), { role: "user" as const, content: qn }];
    setMsgs(next); setInput(""); setBusy(true);
    try {
      // History sent to the agent: text only; proposals are summarised so it knows what is waiting or done.
      const history = next.slice(-20).map(({ role, content, proposals }) => ({ role, content: proposals?.length ? `${content}\n\n[Proposals: ${proposals.map((p) => `${p.id} ${p.summary} — ${p.state === "done" ? "CONFIRMED and done" : p.state === "dismissed" ? "dismissed by admin" : p.state === "error" ? `failed: ${p.note}` : "not confirmed yet"}`).join("; ")}]` : content }));
      const r = await api<{ answer: string; steps: string[]; proposals: Proposal[] }>(q("/api/accounting/ai/agent"), { json: { messages: history } });
      setMsgs([...next, { role: "assistant", content: r.answer, steps: r.steps, proposals: r.proposals }]);
    } catch (e) { setMsgs([...next, { role: "assistant", content: errMsg(e), error: true }]); } finally { setBusy(false); }
  };
  const setProposal = (mi: number, pid: string, patch: Partial<Proposal>) => setMsgs((ms) => ms.map((m, i) => (i === mi ? { ...m, proposals: m.proposals?.map((p) => (p.id === pid ? { ...p, ...patch } : p)) } : m)));
  const confirm = async (mi: number, p: Proposal) => {
    if (p.needsElevation && !(await ensure())) return;
    setProposal(mi, p.id, { state: "busy" });
    try { const r = await api<{ done: string }>("/api/accounting/ai/agent/execute", { json: { action: p.action } }); setProposal(mi, p.id, { state: "done", note: r.done }); }
    catch (e) { setProposal(mi, p.id, { state: "error", note: errMsg(e) }); }
  };
  if (ai.data && !ai.data.enabled) return <div className="p-4 text-sm"><p className="mb-2 font-medium">{t("setupTitle")}</p><p className="text-muted">{t("setup")}</p><Link href="/accounting/settings" className="mt-2 inline-block underline underline-offset-4">{t("openSettings")}</Link></div>;
  const suggestions = [t("s1"), t("s2"), t("s3"), t("s4"), t("s5"), t("s6")];
  return (
    <div className={cn("flex min-h-0 flex-col", compact ? "h-full" : "h-[70vh]")}>
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
        {!msgs.length && <div className="space-y-3"><p className="text-muted">{t("intro")}</p><div className="flex flex-wrap gap-2">{suggestions.map((s) => <button key={s} type="button" onClick={() => void ask(s)} className="rounded-full border border-line-strong px-3 py-1.5 text-start text-xs hover:border-accent hover:bg-accent-soft">{s}</button>)}</div></div>}
        {msgs.map((m, i) => <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
          <div className={cn("max-w-[92%] rounded-2xl px-3.5 py-2.5", m.role === "user" ? "bg-fg text-bg" : m.error ? "border border-fin-neg/40 bg-fin-neg/10" : "bg-surface-2")}>
            {m.steps && m.steps.length > 0 && <p className="mb-1.5 flex items-start gap-1.5 text-[11px] text-muted"><Search className="mt-0.5 size-3 shrink-0" aria-hidden />{t("checked", { what: m.steps.join(", ") })}</p>}
            {m.role === "assistant" && !m.error ? <Answer text={m.content} /> : <p className="whitespace-pre-wrap">{m.content}</p>}
            {m.proposals?.map((p) => <div key={p.id} className="mt-2.5 rounded-xl border border-line-strong bg-surface p-3">
              <p className="text-xs font-medium">{p.summary}</p>
              {p.state === "done" ? <p className="mt-2 flex items-center gap-1.5 text-xs"><CheckCircle2 className="size-3.5" aria-hidden />{p.note}</p>
                : p.state === "dismissed" ? <p className="mt-2 text-xs text-muted">{t("dismissed")}</p>
                : !can("accounting.manage") ? <p className="mt-2 text-xs text-muted">{t("noPermission")}</p>
                : <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="primary" loading={p.state === "busy"} onClick={() => void confirm(i, p)}><Check className="size-3.5" aria-hidden />{t("confirm")}</Button>
                  <Button size="sm" variant="ghost" disabled={p.state === "busy"} onClick={() => setProposal(i, p.id, { state: "dismissed" })}>{t("dismiss")}</Button>
                  {p.state === "error" && <span className="text-xs">{p.note}</span>}
                </div>}
            </div>)}
          </div>
        </div>)}
        {busy && <div className="flex items-center gap-2 text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />{t("thinking")}</div>}
        <div ref={end} />
      </div>
      <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        {msgs.length > 0 && <Button size="icon" variant="ghost" type="button" aria-label={t("clear")} onClick={() => setMsgs([])}><Trash2 className="size-4" /></Button>}
        <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }} rows={1} placeholder={t("placeholder")} aria-label={t("placeholder")}
          className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
        <Button type="submit" variant="primary" size="icon" aria-label={t("send")} disabled={busy || !input.trim()}><Send className="size-4" /></Button>
      </form>
      <p className="px-3 pb-2 text-[11px] text-muted">{t("disclaimer")}</p>
    </div>
  );
}

/** Floating assistant button on every Finance page. */
export function FloatingChat() {
  const t = useTranslations("accounting.aichat");
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && <div role="dialog" aria-label={t("title")} className="fixed bottom-20 end-4 z-50 flex h-[min(620px,calc(100dvh-7rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line bg-[var(--color-12)] px-4 py-3 text-[var(--color-1)]">
          <span className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4" aria-hidden />{t("title")}</span>
          <span className="flex items-center gap-1"><Link href="/accounting/ai" className="rounded-lg px-2 py-1 text-xs underline-offset-4 hover:underline" onClick={() => setOpen(false)}>{t("openPage")}</Link>
            <button type="button" aria-label={t("close")} onClick={() => setOpen(false)} className="grid size-8 place-items-center rounded-lg hover:bg-white/10"><X className="size-4" /></button></span>
        </div>
        <ChatPanel compact />
      </div>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("title")}
        className="fixed bottom-4 end-4 z-50 grid size-14 place-items-center rounded-full bg-accent text-accent-fg shadow-2xl transition hover:scale-105">
        {open ? <X className="size-6" aria-hidden /> : <MessageCircle className="size-6" aria-hidden />}
      </button>
    </>
  );
}
