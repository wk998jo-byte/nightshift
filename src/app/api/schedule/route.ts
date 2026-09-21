import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canManageSchedule, choiceForAssignment, type ShiftChoice } from '@/lib/shift-catalog';
import {
  loadShiftCatalog,
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
    if (span > 14) {
      return NextResponse.json({ error: 'Date range too large' }, { status: 400 });
    }
  }

  const catalog = await loadShiftCatalog(prisma);
  const employees = await prisma.employee.findMany({
    where: { isActive: true, user: { role: 'EMPLOYEE' } },
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
