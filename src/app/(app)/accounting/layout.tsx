"use client";
import { FinanceGate, FinanceHeader, FinanceNav, FinanceSidebar, ModeBanner } from "@/components/accounting/kit";
import { FloatingChat } from "@/components/accounting/ai-chat";

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <FinanceGate>
      <FinanceHeader />
      <FinanceNav />
      <div className="flex gap-6">
        <FinanceSidebar />
        <div className="min-w-0 flex-1">
          <ModeBanner />
          {children}
        </div>
      </div>
      <FloatingChat />
    </FinanceGate>
  );
}
