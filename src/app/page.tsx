import { redirect } from "next/navigation";
import { currentAuth } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export default async function Home() { redirect((await currentAuth()) ? "/dashboard" : "/login"); }
