import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  canManageSchedule,
  choiceForAssignment,
  SHIFT_SCHEDULE_EMPLOYEE_WHERE,
  type ShiftChoice,
} from '@/lib/shift-catalog';
import {
  datesAfterWeekUntilMonthEnd,
  loadShiftCatalog,
  monthDates,
  monthEnd,
  monthStart,
  planPatternCopy,
  previousWeekStart,
  saveScheduleItems,
  weekDates,
  weekStart,
} from '@/lib/schedule-service';
import { addCalendarDays, calendarDateInAppZone } from '@/lib/timezone';

export async function GET(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageSchedule(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const today = calendarDateInAppZone(new Date());
  const start = req.nextUrl.searchParams.get('start') || today;
  const end = req.nextUrl.searchParams.get('end') || start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }

  let span = 0;
  for (let d = start; d <= end; d = addCalendarDays(d, 1)) {
    span += 1;
    if (span > 31) {
      return NextResponse.json({ error: 'Date range too large' }, { status: 400 });
    }
  }

  const catalog = await loadShiftCatalog(prisma);
  const employees = await prisma.employee.findMany({
    where: SHIFT_SCHEDULE_EMPLOYEE_WHERE,
    orderBy: { fullName: 'asc' },
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      badgeNumber: true,
      defaultProjectId: true,
    },
  });

  const assignments = await prisma.employeeShiftAssignment.findMany({
    where: {
      employeeId: { in: employees.map((e) => e.id) },
      workDate: { gte: start, lte: end },
    },
    include: {
      shift: true,
      attendance: { select: { id: true, checkInAt: true } },
    },
  });

  return NextResponse.json({
    start,
    end,
    today,
    weekStart: weekStart(start),
    weekDates: weekDates(start),
    monthStart: monthStart(start),
    monthEnd: monthEnd(start),
    monthDates: monthDates(start),
    shifts: {
      SHIFT_1: catalog.shift1
        ? {
            id: catalog.shift1.id,
            name: catalog.shift1.name,
            startTime: catalog.shift1.startTime,
            endTime: catalog.shift1.endTime,
          }
        : null,
      SHIFT_2: catalog.shift2
        ? {
            id: catalog.shift2.id,
            name: catalog.shift2.name,
            startTime: catalog.shift2.startTime,
            endTime: catalog.shift2.endTime,
          }
        : null,
    },
    employees,
    assignments: assignments.map((a) => ({
      id: a.id,
      employeeId: a.employeeId,
      workDate: a.workDate,
      shiftId: a.shiftId,
      status: a.status,
      choice: choiceForAssignment(a.shift, a.status, catalog),
      hasAttendance: a.attendance.some((r) => r.checkInAt != null),
    })),
  });
}

export async function PUT(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageSchedule(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ error: 'items required' }, { status: 400 });
  }

  const items = rawItems.map((row: { employeeId?: string; workDate?: string; choice?: string }) => ({
    employeeId: String(row.employeeId || ''),
    workDate: String(row.workDate || ''),
    choice: String(row.choice || '') as ShiftChoice,
  }));

  const result = await saveScheduleItems(prisma, {
    actorId: auth.sub,
    items,
    writeAudit,
  });

  if (result.errors.length > 0 && result.saved === 0) {
    return NextResponse.json({ ok: false, ...result }, { status: 409 });
  }

  return NextResponse.json({ ok: result.errors.length === 0, ...result });
}

export async function POST(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageSchedule(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  const overwriteExisting = body.overwriteExisting === true;
  const anchor = String(body.weekStart || body.anchor || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    return NextResponse.json({ error: 'weekStart required' }, { status: 400 });
  }
  if (action !== 'copy-previous-week' && action !== 'repeat-week-to-month-end') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const catalog = await loadShiftCatalog(prisma);
  const employees = await prisma.employee.findMany({
    where: SHIFT_SCHEDULE_EMPLOYEE_WHERE,
    select: { id: true, fullName: true },
  });
  const employeeIds = employees.map((e) => e.id);
  const names = new Map(employees.map((e) => [e.id, e.fullName]));

  const sourceDates =
    action === 'copy-previous-week' ? weekDates(previousWeekStart(anchor)) : weekDates(anchor);
  const targetDates =
    action === 'copy-previous-week' ? weekDates(anchor) : datesAfterWeekUntilMonthEnd(anchor);

  const rangeStart = [...sourceDates, ...targetDates].sort()[0];
  const rangeEnd = [...sourceDates, ...targetDates].sort().reverse()[0];
  const assignments = await prisma.employeeShiftAssignment.findMany({
    where: {
      employeeId: { in: employeeIds },
      workDate: { gte: rangeStart, lte: rangeEnd },
    },
    include: { shift: true, attendance: { select: { checkInAt: true } } },
  });

  const sourceChoices = new Map<string, ShiftChoice>();
  const existing = new Set<string>();
  const locked = new Set<string>();
  for (const a of assignments) {
    const key = `${a.employeeId}:${a.workDate}`;
    existing.add(key);
    if (a.attendance.some((r) => r.checkInAt != null)) locked.add(key);
    sourceChoices.set(key, choiceForAssignment(a.shift, a.status, catalog));
  }

  const plan = planPatternCopy({
    employeeIds,
    sourceDates,
    targetDates,
    sourceChoices,
    existing,
    locked,
    today: calendarDateInAppZone(new Date()),
    overwriteExisting,
  });

  if (plan.wouldOverwrite > 0 && !overwriteExisting) {
    return NextResponse.json(
      {
        ok: false,
        needsConfirmation: true,
        message:
          'Some future days already have a schedule. Confirm to replace them. Attendance-locked days will not change.',
        ...plan,
      },
      { status: 409 }
    );
  }

  if (plan.items.length === 0) {
    return NextResponse.json({
      ok: true,
      saved: 0,
      errors: [],
      skippedLocked: plan.skippedLocked,
      skippedPast: plan.skippedPast,
      message: 'Nothing to copy.',
    });
  }

  const result = await saveScheduleItems(prisma, {
    actorId: auth.sub,
    items: plan.items,
    writeAudit,
  });

  await writeAudit({
    actorId: auth.sub,
    action: action === 'copy-previous-week' ? 'SCHEDULE_COPIED' : 'SCHEDULE_REPEATED',
    entityType: 'EmployeeShiftAssignment',
    newValue: {
      action,
      sourceDates,
      targetDates,
      saved: result.saved,
      skippedLocked: plan.skippedLocked,
      skippedPast: plan.skippedPast,
    },
  });

  const errors = result.errors.map((e) => ({
    ...e,
    employeeName: e.employeeName || names.get(e.employeeId),
  }));

  return NextResponse.json({
    ok: result.errors.length === 0,
    ...result,
    errors,
    skippedLocked: plan.skippedLocked,
    skippedPast: plan.skippedPast,
  });
}
