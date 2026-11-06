"use client";
import { Check, ShieldCheck, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { AssistantChat } from "@/components/assistant-chat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

interface Proposal { id: string; kind: string; summary: string; status: "pending" | "approved" | "rejected" | "failed"; error: string | null; created_at: string; decided_at: string | null }
const statusTone = { pending: "amber", approved: "brand", rejected: "gray", failed: "red" } as const;
const statusLabel = { pending: "بانتظار موافقتك", approved: "تم التنفيذ", rejected: "مرفوض", failed: "فشل التنفيذ" };

export default function AssistantPage() {
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const q = useQuery(async () => must(await sb.from("ai_action_proposals").select("*").eq("school_id", school.id)
    .order("created_at", { ascending: false }).limit(20)) as Proposal[], [school.id]);

  async function decide(p: Proposal, approve: boolean) {
    const { data, error } = await sb.rpc("decide_ai_proposal", { p_id: p.id, p_approve: approve });
    if (error) return toast.error(toAppError(error).message);
    const r = data as Proposal;
    if (r.status === "failed") toast.error("تعذّر تنفيذ التغيير", r.error ?? undefined);
    else toast.success(approve ? "تم تنفيذ التغيير" : "تم رفض الاقتراح");
    q.reload(true);
  }

  return (
    <div className="pb-6">
      <PageHeader title="المساعد الذكي" subtitle="اسأل عن بيانات النقل في مدرستك. أي تغيير يقترحه المساعد لا يُنفّذ إلا بموافقتك." />
      <div className="grid gap-4 px-4 lg:px-8 xl:grid-cols-[1fr_380px]">
        <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <AssistantChat endpoint="/api/assistant/school" context={{ school_id: school.id }} className="h-[calc(100dvh-13rem)] min-h-[480px]"
            onReply={() => q.reload(true)}
            intro="أستطيع تلخيص حالة النقل، واكتشاف التأخير والمشكلات، وتحليل التقارير، واقتراح إعادة توزيع الطلاب عند ازدحام الباصات."
            suggestions={["اعرض لي ملخص النقل المدرسي اليوم", "كم طالبًا لم يصل إلى المدرسة حتى الآن؟", "ما الباصات المتأخرة اليوم؟",
              "هل عندنا باصات تجاوزت سعتها؟", "ما أكثر الرحلات تأخرًا هذا الأسبوع؟", "جهز لي تقريرًا عن حضور الطلاب هذا الأسبوع"]} />
        </section>
        <section className="h-fit rounded-2xl border border-line bg-white shadow-card">
          <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 font-semibold"><ShieldCheck className="size-5 text-brand-600" />اقتراحات بانتظار الموافقة</h2>
          <ul className="divide-y divide-line">
            {(q.data ?? []).length === 0 && <li className="p-6 text-center text-sm text-ink-muted">لا توجد اقتراحات. عندما يقترح المساعد تغييرًا سيظهر هنا لتوافق عليه أو ترفضه.</li>}
            {(q.data ?? []).map((p) => (
              <li key={p.id} className="p-4">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Badge tone={statusTone[p.status]}>{statusLabel[p.status]}</Badge>
                  <span className="text-xs text-ink-soft">{fmtDateTime(p.created_at, school.timezone)}</span>
                </div>
                <p className="text-sm">{p.summary}</p>
                {p.error && <p className="mt-1 text-xs text-red-600">{p.error}</p>}
                {p.status === "pending" && canEdit && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => decide(p, true)}><Check className="size-4" />موافقة وتنفيذ</Button>
                    <Button size="sm" variant="secondary" onClick={() => decide(p, false)}><X className="size-4" />رفض</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
