import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { formatDuration, formatTime } from '@/lib/attendance-calc';
import { ensureTonightAssignment, getShiftTiming } from '@/lib/schedule';

export async function GET() {
  const auth = await getSession();
  if (!auth || !auth.employeeId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const employee = await prisma.employee.findUnique({
    where: { id: auth.employeeId },
    include: { defaultProject: true },
  });
  if (!employee) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const open = await prisma.attendanceRecord.findFirst({
    where: {
      employeeId: employee.id,
      checkInAt: { not: null },
      checkOutAt: null,
    },
    include: { project: true, shift: true },
  });

  const ensured = await ensureTonightAssignment(
    employee.id,
    employee.defaultProjectId || undefined
  );

  let schedule = null;
  let timing = null;

  if (ensured) {
    const { assignment, window, timing: t } = ensured;
    // Refresh timing with current clock
    timing = getShiftTiming(
      new Date(),
      window.scheduledStart,
      window.scheduledEnd,
      assignment.shift.gracePeriodMinutes
    );
    schedule = {
      workDate: assignment.workDate,
      project: assignment.project,
      shift: {
        name: assignment.shift.name,
        startTime: assignment.shift.startTime,
        endTime: assignment.shift.endTime,
        gracePeriodMinutes: assignment.shift.gracePeriodMinutes,
      },
      scheduledStart: window.scheduledStart.toISOString(),
      scheduledEnd: window.scheduledEnd.toISOString(),
    };
  }

  const history = await prisma.attendanceRecord.findMany({
    where: { employeeId: employee.id },
    orderBy: { scheduledStart: 'desc' },
    take: 14,
    include: { project: true },
  });

  const nowMs = Date.now();
  const currentWorked =
    open?.checkInAt != null
      ? Math.floor((nowMs - open.checkInAt.getTime()) / 60000)
      : null;

  let openTiming = null;
  if (open) {
    openTiming = getShiftTiming(
      new Date(),
      open.scheduledStart,
      open.scheduledEnd,
      open.shift.gracePeriodMinutes
    );
  }

  return NextResponse.json({
    employee: {
      id: employee.id,
      fullName: employee.fullName,
      employeeCode: employee.employeeCode,
      badgeNumber: employee.badgeNumber,
      company: employee.company,
      position: employee.position,
    },
    openShift: open
      ? {
          id: open.id,
          project: open.project,
          shift: open.shift,
          checkInAt: open.checkInAt,
          lateMinutes: open.lateMinutes,
          currentWorkedMinutes: currentWorked,
          currentWorkedLabel: formatDuration(currentWorked),
          checkInLabel: formatTime(open.checkInAt),
          scheduledStart: open.scheduledStart.toISOString(),
          scheduledEnd: open.scheduledEnd.toISOString(),
          timing: openTiming,
        }
      : null,
    schedule,
    timing,
    serverNow: new Date().toISOString(),
    history: history.map((h) => ({
      id: h.id,
      project: h.project.name,
      checkInAt: h.checkInAt,
      checkOutAt: h.checkOutAt,
      workedMinutes: h.workedMinutes,
      lateMinutes: h.lateMinutes,
      earlyLeaveMinutes: h.earlyLeaveMinutes,
      overtimeMinutes: h.overtimeMinutes,
      statusPrimary: h.statusPrimary,
      flags: JSON.parse(h.flags || '[]'),
    })),
  });
}
