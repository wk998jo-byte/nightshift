import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canManageSchedule, SHIFT_SCHEDULE_EMPLOYEE_WHERE } from '@/lib/shift-catalog';
import { planDayException, planRemoveDayException } from '@/lib/day-exception-service';
import type { DayExceptionType } from '@/lib/day-status';

export async function GET(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageSchedule(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const date = req.nextUrl.searchParams.get('date') || '';
  const start = req.nextUrl.searchParams.get('start') || date;
  const end = req.nextUrl.searchParams.get('end') || date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }

  const [exceptions, employees] = await Promise.all([
    prisma.dayException.findMany({
      where: { workDate: { gte: start, lte: end } },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
      orderBy: [{ workDate: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.employee.findMany({
      where: SHIFT_SCHEDULE_EMPLOYEE_WHERE,
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, employeeCode: true, badgeNumber: true },
    }),
  ]);

  return NextResponse.json({ start, end, exceptions, employees });
}

export async function POST(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageSchedule(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const workDate = String(body.workDate || '');
  const scope = body.scope === 'HOLIDAY' || body.scope === 'ALL' ? 'HOLIDAY' : 'EMPLOYEE';
  const type = String(body.type || '') as DayExceptionType;
  const employeeId = body.employeeId ? String(body.employeeId) : null;
  const reason = body.reason ? String(body.reason) : null;
  const expectedStartTime = body.expectedStartTime ? String(body.expectedStartTime) : null;
  const expectedEndTime = body.expectedEndTime ? String(body.expectedEndTime) : null;
  const expectedWorkMinutes =
    body.expectedWorkMinutes != null && body.expectedWorkMinutes !== ''
      ? Number(body.expectedWorkMinutes)
      : null;

  const existing = employeeId
    ? await prisma.dayException.findFirst({ where: { employeeId, workDate } })
    : await prisma.dayException.findFirst({
        where: { workDate, employeeId: null, type: 'HOLIDAY' },
      });

  const plan = planDayException(
    {
      workDate,
      scope,
      type,
      employeeId,
      reason,
      expectedStartTime,
      expectedEndTime,
      expectedWorkMinutes: Number.isFinite(expectedWorkMinutes) ? expectedWorkMinutes : null,
    },
    existing
  );
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: plan.status });

  const data = {
    workDate: plan.planned.workDate,
    employeeId: plan.planned.employeeId,
    type: plan.planned.type,
    reason: plan.planned.reason,
    expectedStartTime: plan.planned.expectedStartTime,
    expectedEndTime: plan.planned.expectedEndTime,
    expectedWorkMinutes: plan.planned.expectedWorkMinutes,
    createdById: auth.sub,
  };

  const saved = existing
    ? await prisma.dayException.update({ where: { id: existing.id }, data })
    : await prisma.dayException.create({ data });

  await writeAudit({
    actorId: auth.sub,
    action: plan.planned.auditAction,
    entityType: 'DayException',
    entityId: saved.id,
    employeeId: plan.planned.employeeId || undefined,
    oldValue: existing
      ? {
          workDate: existing.workDate,
          type: existing.type,
          employeeId: existing.employeeId,
          reason: existing.reason,
        }
      : null,
    newValue: {
      workDate: saved.workDate,
      type: saved.type,
      employeeId: saved.employeeId,
      reason: saved.reason,
      expectedStartTime: saved.expectedStartTime,
      expectedEndTime: saved.expectedEndTime,
      expectedWorkMinutes: saved.expectedWorkMinutes,
    },
  });

  return NextResponse.json({ ok: true, exception: saved });
}

export async function DELETE(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageSchedule(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const id = req.nextUrl.searchParams.get('id') || '';
  const existing = id ? await prisma.dayException.findUnique({ where: { id } }) : null;
  const plan = planRemoveDayException(existing);
  if (!plan.ok || !existing) {
    return NextResponse.json({ error: plan.error || 'Exception not found' }, { status: plan.status || 404 });
  }

  await prisma.dayException.delete({ where: { id: existing.id } });
  await writeAudit({
    actorId: auth.sub,
    action: plan.auditAction,
    entityType: 'DayException',
    entityId: existing.id,
    employeeId: existing.employeeId || undefined,
    oldValue: {
      workDate: existing.workDate,
      type: existing.type,
      employeeId: existing.employeeId,
      reason: existing.reason,
    },
    newValue: null,
  });
  return NextResponse.json({ ok: true });
}
