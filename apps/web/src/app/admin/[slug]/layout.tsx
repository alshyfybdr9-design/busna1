import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import type { MemberRole, School } from "@/lib/types";
import { SchoolProvider } from "@/components/admin/school-context";
import { AdminShell } from "@/components/admin/shell";
import { brandVars } from "@/components/brand";

export default async function AdminLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/admin/${slug}`);

  // RLS returns the school only if the user is affiliated with it.
  const { data: school } = await supabase.from("schools").select("*").eq("slug", slug).maybeSingle();
  if (!school) notFound();
  const { data: member } = await supabase.from("school_members").select("role")
    .eq("school_id", school.id).eq("user_id", user.id).maybeSingle();
  if (!member) notFound(); // staff/parents of this school have no dashboard access

  return (
    <div style={brandVars(school.primary_color)}>
      <SchoolProvider school={school as School} role={member.role as MemberRole}>
        <AdminShell>{children}</AdminShell>
      </SchoolProvider>
    </div>
  );
}
