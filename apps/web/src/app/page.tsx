import Link from "next/link";
import { redirect } from "next/navigation";
import { Bus, LayoutDashboard, Users, UserRound } from "lucide-react";
import { supabaseServer } from "@/lib/supabase/server";
import type { MyAccess } from "@/lib/types";
import { BusnaLogo } from "@/components/brand";
import { EmptyState } from "@/components/ui/states";
import { SignOutButton } from "@/components/sign-out";

interface Destination { href: string; title: string; subtitle: string; icon: typeof Bus }

export default async function Home() {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Link staff/guardian records created by the school to this verified account.
  await supabase.rpc("claim_my_records");
  const { data: access, error } = await supabase.rpc("my_access");
  if (error) throw error;
  const a = access as MyAccess;

  const destinations: Destination[] = [
    ...a.schools.map((s) => ({
      href: `/admin/${s.slug}`,
      title: s.name,
      subtitle: s.role === "viewer" ? "لوحة المدرسة (مشاهدة)" : "لوحة إدارة المدرسة",
      icon: LayoutDashboard,
    })),
    ...(a.staff.some((s) => s.role === "driver")
      ? [{ href: "/staff", title: "تطبيق السائق", subtitle: a.staff.filter((s) => s.role === "driver").map((s) => s.school_name).join("، "), icon: Bus }]
      : []),
    ...(a.staff.some((s) => s.role === "supervisor")
      ? [{ href: "/staff", title: "تطبيق المشرف", subtitle: a.staff.filter((s) => s.role === "supervisor").map((s) => s.school_name).join("، "), icon: Users }]
      : []),
    ...(a.guardian ? [{ href: "/parent", title: "تطبيق ولي الأمر", subtitle: "متابعة الأبناء والباص", icon: UserRound }] : []),
  ];
  const unique = destinations.filter((d, i) => destinations.findIndex((x) => x.href === d.href) === i);

  if (unique.length === 1) redirect(unique[0].href);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <BusnaLogo />
        <SignOutButton />
      </div>
      {unique.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title="لا توجد صلاحيات مرتبطة بحسابك بعد"
          body="إذا كنت ولي أمر أو سائقًا أو مشرفًا، تأكد أن المدرسة سجّلت رقم جوالك نفسه الذي دخلت به. للمساعدة تواصل مع إدارة المدرسة."
        />
      ) : (
        <>
          <h1 className="mb-1 text-xl font-bold">اختر الواجهة</h1>
          <p className="mb-6 text-sm text-ink-muted">حسابك مرتبط بأكثر من دور.</p>
          <ul className="space-y-3">
            {unique.map((d) => (
              <li key={d.href}>
                <Link href={d.href} className="flex items-center gap-4 rounded-2xl border border-line bg-white p-4 shadow-card transition hover:border-brand-300">
                  <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-700"><d.icon className="size-5" /></span>
                  <span className="min-w-0">
                    <span className="block font-semibold">{d.title}</span>
                    <span className="block truncate text-sm text-ink-muted">{d.subtitle}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
