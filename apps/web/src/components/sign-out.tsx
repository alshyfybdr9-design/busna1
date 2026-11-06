"use client";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { cn } from "./ui/cn";

export function SignOutButton({ className, compact }: { className?: string; compact?: boolean }) {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.replace("/login");
        router.refresh();
      }}
      className={cn("inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-ink-muted hover:bg-slate-100", className)}
    >
      <LogOut className="size-4" aria-hidden />
      {!compact && "تسجيل الخروج"}
      {compact && <span className="sr-only">تسجيل الخروج</span>}
    </button>
  );
}
