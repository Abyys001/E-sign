"use client";
import { FinanceGate, FinanceHeader, ModeBanner } from "@/components/accounting/kit";
import { FloatingChat } from "@/components/accounting/ai-chat";

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <FinanceGate>
      <FinanceHeader />
      <ModeBanner />
      {children}
      <FloatingChat />
    </FinanceGate>
  );
}
