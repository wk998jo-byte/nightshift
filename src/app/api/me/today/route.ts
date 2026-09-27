import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { formatDuration, formatTime } from '@/lib/attendance-calc';
import { getTonightAssignment } from '@/lib/schedule';
import { getShiftTiming } from '@/lib/schedule-timing';
import { todayNoStoreHeaders } from '@/lib/session-policy';
import {
  employeeOpenShiftFromRecords,
  isStaleMissingCheckout,
  previousMissingCheckoutMeta,
  withShiftCheckoutWindow,
} from '@/lib/open-attendance';
import {
  effectiveScheduledWindow,
  evaluateNormalQrCheckIn,
  exceptionForEmployee,
} from '@/lib/attendance-state';
import type { DayExceptionRecord } from '@/lib/day-status';

export async function GET() {
  const headers = todayNoStoreHeaders();
  const auth = await getSession();
  if (!auth || !auth.employeeId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  }

  const employee = await prisma.employee.findUnique({
    where: { id: auth.employeeId },
    include: { defaultProject: true },
  });
  if (!employee) return NextResponse.json({ error: 'Not found' }, { status: 404, headers });

  const openRecords = await prisma.attendanceRecord.findMany({
    where: {
      employeeId: employee.id,
      checkInAt: { not: null },
      checkOutAt: null,
    },
    include: { project: true, shift: true, assignment: { select: { workDate: true } } },
  });
  const classified = openRecords.map((row) => withShiftCheckoutWindow(row));
  const now = new Date();
  const open = employeeOpenShiftFromRecords(classified, now);
  const previousMissingCheckout = previousMissingCheckoutMeta(classified, now);

  const lookup = await getTonightAssignment(employee.id, now);

  let schedule = null;
  let timing = null;
  let scheduleState: 'SCHEDULED' | 'OFF_DAY' | 'NO_SCHEDULE' = lookup.kind;
  let checkInEligibility: {
    allowed: boolean;
    code: string | null;
    error: string | null;
    minutesUntilOpen?: number;
    opensAt?: string;
  } = { allowed: false, code: lookup.kind === 'NO_SCHEDULE' ? 'NO_SCHEDULE' : lookup.kind === 'OFF_DAY' ? 'OFF_DAY' : null, error: null };

  if (lookup.assignment) {
    const exceptionRows = await prisma.dayException.findMany({
      where: {
        workDate: lookup.assignment.workDate,
        OR: [{ employeeId: employee.id }, { employeeId: null, type: 'HOLIDAY' }],
      },
    });
    const exceptions: DayExceptionRecord[] = exceptionRows.map((row) => ({
      workDate: row.workDate,
      employeeId: row.employeeId,
      type: row.type as DayExceptionRecord['type'],
      expectedStartTime: row.expectedStartTime,
      expectedEndTime: row.expectedEndTime,
      expectedWorkMinutes: row.expectedWorkMinutes,
    }));
    const exception = exceptionForEmployee(lookup.assignment.workDate, employee.id, exceptions);
    const window = effectiveScheduledWindow({
      workDate: lookup.assignment.workDate,
      startTime: lookup.assignment.shift.startTime,
      endTime: lookup.assignment.shift.endTime,
      crossesMidnight: lookup.assignment.shift.crossesMidnight,
      exception,
    });
    const decision = evaluateNormalQrCheckIn({
      scheduleKind: lookup.kind,
      now,
      workDate: lookup.assignment.workDate,
      startTime: lookup.assignment.shift.startTime,
      endTime: lookup.assignment.shift.endTime,
      crossesMidnight: lookup.assignment.shift.crossesMidnight,
      checkinWindowBeforeMinutes: lookup.assignment.shift.checkinWindowBeforeMinutes,
      exception,
    });
    if (lookup.kind === 'SCHEDULED' && window) {
      timing = getShiftTiming(
        now,
        window.scheduledStart,
        window.scheduledEnd,
        lookup.assignment.shift.gracePeriodMinutes
      );
      schedule = {
        workDate: lookup.assignment.workDate,
        project: lookup.assignment.project,
        shift: {
          name: lookup.assignment.shift.name,
          startTime: lookup.assignment.shift.startTime,
          endTime: lookup.assignment.shift.endTime,
          gracePeriodMinutes: lookup.assignment.shift.gracePeriodMinutes,
        },
        scheduledStart: window.scheduledStart.toISOString(),
        scheduledEnd: window.scheduledEnd.toISOString(),
      };
    }
    checkInEligibility = decision.ok
      ? { allowed: true, code: null, error: null }
      : {
          allowed: false,
          code: decision.code,
          error: decision.error,
          minutesUntilOpen: decision.minutesUntilOpen,
          opensAt: decision.opensAt,
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
    scheduleState,
    scheduleMessage:
      scheduleState === 'NO_SCHEDULE'
        ? 'No shift scheduled for today.'
        : scheduleState === 'OFF_DAY'
          ? 'You are scheduled OFF today.'
          : null,
    timing,
    checkInEligibility,
    previousMissingCheckout,
    serverNow: new Date().toISOString(),
    history: history.map((h) => {
      const stale =
        h.checkInAt &&
        !h.checkOutAt &&
        isStaleMissingCheckout(
          {
            checkInAt: h.checkInAt,
            checkOutAt: h.checkOutAt,
            scheduledEnd: h.scheduledEnd,
          },
          now
        );
      return {
        id: h.id,
        project: h.project.name,
        checkInAt: h.checkInAt,
        checkOutAt: h.checkOutAt,
        workedMinutes: stale ? null : h.workedMinutes,
        lateMinutes: h.lateMinutes,
        earlyLeaveMinutes: stale ? null : h.earlyLeaveMinutes,
        overtimeMinutes: stale ? null : h.overtimeMinutes,
        statusPrimary: stale ? 'MISSING_CHECKOUT' : h.statusPrimary,
        flags: stale ? ['MISSING_CHECKOUT'] : JSON.parse(h.flags || '[]'),
      };
    }),
  }, { headers });
}
