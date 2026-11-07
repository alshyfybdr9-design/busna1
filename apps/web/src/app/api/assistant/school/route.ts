import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { assistantAvailable, assistantErrorMessage, ChatBody, checkRateLimit, obj, runAssistant, type AssistantTool } from "@/lib/assistant/engine";

export const runtime = "nodejs";
export const maxDuration = 120;

const SYSTEM = `أنت "مساعد باصنا" لإدارة النقل في المدرسة. أنت مساعد تشغيلي عملي وليس محادثًا عامًا. أجب بالعربية بإيجاز ووضوح، واستخدم قوائم مختصرة وأرقامًا عند الحاجة.

القواعد:
- اعتمد فقط على نتائج الأدوات، ولا تخترع أرقامًا أو أسماء أو أسبابًا. إذا لم تتوفر البيانات قل ذلك.
- عند تلخيص يوم النقل: ابدأ بما يحتاج تدخلًا الآن (طوارئ، رحلات لم تبدأ في موعدها، تأخير، انقطاع GPS، تجاوز سعة، طلبات مفتوحة)، ثم الأرقام العامة.
- لاقتراح تحسينات في توزيع الطلاب: استخدم بيانات الإشغال ومواقع الطلاب، واشرح سبب الاقتراح.
- أي تغيير يؤثر على الطلاب أو الرحلات (نقل طالب لباص آخر، تغيير سائق أو باص لرحلة) لا تنفذه أبدًا. استخدم أداة propose_change لإنشاء اقتراح، وأخبر المستخدم أن الاقتراح يظهر أسفل المحادثة ولا يُنفّذ إلا بعد ضغطه "موافقة".
- التقارير: استخدم run_report بالفترة المطلوبة، ثم لخّص النتائج بلغة طبيعية مع أبرز الملاحظات. أخبر المستخدم أنه يستطيع تصدير التقرير الكامل من صفحة التقارير.
- لا تعرض المعرفات الداخلية (UUID) للمستخدم.`;

export async function POST(req: Request) {
  if (!assistantAvailable()) return NextResponse.json({ error: "المساعد الذكي غير مفعّل. أضف مفتاح ANTHROPIC_API_KEY في إعدادات الخادم." }, { status: 503 });
  const parsed = ChatBody.safeParse(await req.json().catch(() => null));
  const schoolId = parsed.success ? parsed.data.context?.school_id : null;
  if (!parsed.success || !schoolId) return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });

  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "يجب تسجيل الدخول" }, { status: 401 });
  // Dashboard members only (parents/staff of the school are rejected here;
  // RLS would also restrict every query below).
  const { data: member } = await sb.from("school_members").select("role").eq("school_id", schoolId).eq("user_id", user.id).maybeSingle();
  if (!member) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  const limited = await checkRateLimit(sb, "assistant_school");
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status, headers: { "Retry-After": String(limited.retryAfter) } });
  const { data: school } = await sb.from("schools").select("name, timezone, settings").eq("id", schoolId).single();
  const tz = school?.timezone ?? "Asia/Riyadh";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

  const must = <T,>(r: { data: T | null; error: unknown }) => { if (r.error) throw r.error; return r.data as T; };

  const tools: AssistantTool[] = [
    {
      name: "get_dashboard",
      description: "Today's (or a given date's) transport KPIs: students registered/on bus/at school/home/absent, trips active/completed/scheduled/cancelled/delayed/not started late, emergencies, buses available/on trip/stopped/over capacity, drivers, supervisors, open incidents, open parent requests.",
      input_schema: obj({ date: { type: ["string", "null"], description: "YYYY-MM-DD; null for today" } }),
      run: async ({ date }) => must(await sb.rpc("school_dashboard", { p_school: schoolId, p_date: date ?? null })),
    },
    {
      name: "list_trips",
      description: "Trips on a date with name, period, status, scheduled/actual times, delay, emergency flag, bus, driver, supervisor, live GPS last update, and attendance counts.",
      input_schema: obj({ date: { type: ["string", "null"] } }),
      run: async ({ date }) => {
        const d = (date as string | null) ?? today;
        const trips = must(await sb.from("trips")
          .select("id, name, period, status, scheduled_start, started_at, arrived_at, completed_at, delay_minutes, delay_reason, emergency_active, cancel_reason, bus:buses(code, capacity), driver:staff!trips_driver_id_school_id_fkey(full_name), supervisor:staff!trips_supervisor_id_school_id_fkey(full_name), students:trip_students(status), live:bus_live_positions(recorded_at)")
          .eq("school_id", schoolId).eq("trip_date", d).order("scheduled_start")) as Record<string, unknown>[];
        return trips.map((t) => {
          const st = (t.students as { status: string }[]) ?? [];
          const count = (s: string) => st.filter((x) => x.status === s).length;
          return { ...t, students: undefined, total_students: st.length, boarded: count("boarded"), dropped: count("dropped"), absent: count("absent"), pending: count("pending") };
        });
      },
    },
    {
      name: "get_trip_timeline",
      description: "Full event timeline of one trip (start, each boarding/drop/absence with student name, arrival, notes, delays, incidents, completion) with actor roles and times.",
      input_schema: obj({ trip_id: { type: "string" } }),
      run: async ({ trip_id }) => must(await sb.from("trip_events").select("type, actor_role, data, created_at").eq("trip_id", trip_id).eq("school_id", schoolId).order("created_at")),
    },
    {
      name: "get_bus_loads",
      description: "Every bus with capacity, status, number of active students assigned, and over_capacity flag.",
      input_schema: obj({}),
      run: async () => must(await sb.from("bus_load").select("code, plate_number, capacity, status, assigned_students, over_capacity").eq("school_id", schoolId)),
    },
    {
      name: "find_students",
      description: "Search students by (part of) name or student number. Returns grade, bus, pickup label/coordinates, transport status.",
      input_schema: obj({ query: { type: "string", minLength: 1 } }),
      run: async ({ query }) => {
        const q = String(query).replace(/[%,()]/g, " ").trim();
        return must(await sb.from("students").select("id, full_name, student_number, grade, section, pickup_label, pickup_lat, pickup_lng, transport_status, bus:buses(id, code)")
          .eq("school_id", schoolId).or(`full_name.ilike.%${q}%,student_number.ilike.%${q}%`).limit(25));
      },
    },
    {
      name: "list_buses_and_staff",
      description: "Buses (id, code, capacity, status, default driver/supervisor) and drivers/supervisors (id, name, role, status). Needed to build change proposals.",
      input_schema: obj({}),
      run: async () => ({
        buses: must(await sb.from("buses").select("id, code, plate_number, capacity, status, default_driver_id, default_supervisor_id").eq("school_id", schoolId)),
        staff: must(await sb.from("staff").select("id, full_name, role, status").eq("school_id", schoolId)),
        routes: must(await sb.from("routes").select("id, name, period, bus_id, driver_id, supervisor_id, departure_time, active").eq("school_id", schoolId)),
      }),
    },
    {
      name: "list_open_issues",
      description: "Unresolved incidents reported by drivers/supervisors and open parent requests/complaints.",
      input_schema: obj({}),
      run: async () => ({
        incidents: must(await sb.from("incidents").select("category, severity, description, status, reporter_role, created_at, trip:trips(name)").eq("school_id", schoolId).neq("status", "resolved").order("created_at", { ascending: false }).limit(30)),
        requests: must(await sb.from("parent_requests").select("kind, body, status, created_at, student:students(full_name)").eq("school_id", schoolId).in("status", ["open", "in_review"]).order("created_at", { ascending: false }).limit(30)),
      }),
    },
    {
      name: "run_report",
      description: "Aggregated report rows for a date range. kinds: attendance (per student), trips (per trip), delays, drivers (on-time %), buses (occupancy), absences, incidents, punctuality (morning arrival before school start).",
      input_schema: obj({
        kind: { type: "string", enum: ["attendance", "trips", "delays", "drivers", "buses", "absences", "incidents", "punctuality"] },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      }),
      run: async ({ kind, from, to }) => {
        const rows = must(await sb.rpc("school_report", { p_school: schoolId, p_kind: kind, p_from: from, p_to: to })) as unknown[];
        return { total_rows: rows.length, rows: rows.slice(0, 150) };
      },
    },
    {
      name: "propose_change",
      description: "Creates a PENDING change proposal that an administrator must explicitly approve in the UI before anything changes. kinds: move_student_bus {student_id, bus_id}, change_route_driver {route_id, driver_id}, change_route_bus {route_id, bus_id}. Put unused ids as null.",
      input_schema: obj({
        kind: { type: "string", enum: ["move_student_bus", "change_route_driver", "change_route_bus"] },
        summary: { type: "string", description: "Arabic one-line description shown to the admin, with names (not ids) and the reason" },
        student_id: { type: ["string", "null"] },
        bus_id: { type: ["string", "null"] },
        route_id: { type: ["string", "null"] },
        driver_id: { type: ["string", "null"] },
      }),
      run: async ({ kind, summary, student_id, bus_id, route_id, driver_id }) => {
        if (member.role === "viewer") throw new Error("صلاحية المشاهدة لا تسمح باقتراح تغييرات");
        const payload = kind === "move_student_bus" ? { student_id, bus_id } : kind === "change_route_driver" ? { route_id, driver_id } : { route_id, bus_id };
        if (Object.values(payload).some((v) => !v)) throw new Error("بيانات الاقتراح ناقصة");
        must(await sb.from("ai_action_proposals").insert({ school_id: schoolId, created_by: user.id, kind, summary, payload }));
        return { ok: true, status: "pending_admin_approval" };
      },
    },
  ];

  try {
    const reply = await runAssistant({
      system: `${SYSTEM}\n\nالمدرسة: ${school?.name ?? ""}. تاريخ اليوم: ${today} (${tz}). الوقت الآن: ${new Date().toISOString()}.${member.role === "viewer" ? "\nالمستخدم لديه صلاحية مشاهدة فقط: لا تقترح تغييرات." : ""}`,
      tools,
      messages: parsed.data.messages,
    });
    return NextResponse.json({ reply });
  } catch (err) {
    const { status, error } = assistantErrorMessage(err);
    return NextResponse.json({ error }, { status });
  }
}
