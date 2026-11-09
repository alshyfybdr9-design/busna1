import { one, type Db, type RequestContext } from '../db/pool.js';
import { AppError, notFound } from '../lib/errors.js';
import { audit, todayIn } from '../lib/util.js';
import { loadTenant } from './trips.js';
import { enqueue } from './outbox.js';

export interface AbsenceInput {
  studentId: string;
  date: string;
  direction: 'to_school' | 'from_school' | 'both';
  reason?: string | null;
}

/** تقديم طلب غياب من ولي الأمر — يُستخدم من الشاشة ومن المساعد (بعد تأكيد المستخدم) */
export async function validateAbsence(c: Db, ctx: RequestContext, input: AbsenceInput) {
  const child = await one(c, `select id, full_name from students where id = $1`, [input.studentId]);
  if (!child) throw notFound(); // RLS: غير مرتبط = غير موجود
  const tenant = await loadTenant(c, ctx.tenantId!);
  if (input.date < todayIn(tenant.timezone)) throw new AppError(400, 'absence_date_past');
  return { childName: child.full_name as string };
}

export async function submitAbsence(c: Db, ctx: RequestContext, input: AbsenceInput) {
  await validateAbsence(c, ctx, input);
  const existing = await one(
    c,
    `select id, status, absence_date as "date", direction from absences
     where student_id = $1 and absence_date = $2 and direction = $3 and status in ('pending', 'approved')`,
    [input.studentId, input.date, input.direction],
  );
  if (existing) return { absence: existing, duplicate: true };
  const a = await one(
    c,
    `insert into absences (tenant_id, student_id, absence_date, direction, reason, requested_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [ctx.tenantId, input.studentId, input.date, input.direction, input.reason ?? null, ctx.userId],
  );
  const auto = await one<{ ok: boolean }>(c, `select app.auto_approve_absence($1) as ok`, [a!.id]);
  await audit(c, ctx, 'absence.requested', 'absence', a!.id, { autoApproved: auto?.ok });
  if (auto?.ok) await enqueue(c, ctx.tenantId!, 'absence_updated', { absenceId: a!.id });
  const absence = await one(c, `select id, status, absence_date as "date", direction from absences where id = $1`, [a!.id]);
  return { absence, duplicate: false };
}
