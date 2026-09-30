import { redirect } from "next/navigation";
import { AppShell } from "@/components/app/shell";
import { currentAuth } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await currentAuth())) redirect("/login");
  return <AppShell>{children}</AppShell>;
}
