"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BarChart3, Bus, LayoutDashboard, Menu, Route, Settings, Sparkles, UserRound, Users, UsersRound, X,
} from "lucide-react";
import { BusnaLogo } from "@/components/brand";
import { SignOutButton } from "@/components/sign-out";
import { cn } from "@/components/ui/cn";
import { useSchool } from "./school-context";

const NAV = [
  { href: "", label: "لوحة المتابعة", icon: LayoutDashboard },
  { href: "/trips", label: "الرحلات", icon: Route },
  { href: "/students", label: "الطلاب", icon: Users },
  { href: "/fleet", label: "الباصات", icon: Bus },
  { href: "/staff", label: "السائقون والمشرفون", icon: UserRound },
  { href: "/parents", label: "أولياء الأمور", icon: UsersRound },
  { href: "/reports", label: "التقارير", icon: BarChart3 },
  { href: "/assistant", label: "المساعد الذكي", icon: Sparkles },
  { href: "/settings", label: "الإعدادات", icon: Settings },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { school, role } = useSchool();
  const path = usePathname();
  const base = `/admin/${school.slug}`;
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="space-y-0.5 p-3" aria-label="القائمة الرئيسية">
      {NAV.map((n) => {
        const href = base + n.href;
        const active = n.href === "" ? path === base : path.startsWith(href);
        return (
          <Link key={n.href} href={href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined}
            className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition",
              active ? "bg-brand-50 font-semibold text-brand-800" : "text-ink-muted hover:bg-slate-100 hover:text-ink")}>
            <n.icon className="size-5" aria-hidden />{n.label}
          </Link>
        );
      })}
    </nav>
  );

  const schoolHeader = (
    <div className="flex items-center gap-3 border-b border-line px-4 py-4">
      {school.logo_url
        ? <img src={school.logo_url} alt="" className="size-10 rounded-xl object-contain" />
        : <span className="grid size-10 place-items-center rounded-xl bg-brand-600 font-bold text-white">{school.name[0]}</span>}
      <div className="min-w-0">
        <p className="truncate font-semibold">{school.name}</p>
        <p className="text-xs text-ink-soft">{role === "viewer" ? "صلاحية مشاهدة" : role === "owner" ? "مالك" : "مدير"}</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr] print:block">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh print:!hidden flex-col border-e border-line bg-white lg:flex">
        {schoolHeader}
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="flex items-center justify-between border-t border-line px-4 py-3">
          <BusnaLogo className="text-sm opacity-70 [&_svg]:size-6" />
          <SignOutButton compact />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-white/95 px-4 py-3 backdrop-blur lg:hidden print:hidden">
        <button onClick={() => setOpen(true)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="فتح القائمة"><Menu className="size-6" /></button>
        <span className="truncate font-semibold">{school.name}</span>
        <SignOutButton compact />
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 start-0 w-72 overflow-y-auto bg-white shadow-pop">
            <div className="flex justify-end p-2"><button onClick={() => setOpen(false)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="إغلاق"><X className="size-5" /></button></div>
            {schoolHeader}
            {nav}
          </div>
        </div>
      )}

      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-4 pb-4 pt-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
