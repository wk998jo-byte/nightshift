import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { calculateAttendance } from '@/lib/attendance-calc';
import { getTonightAssignment } from '@/lib/schedule';
import { CURRENT_OPEN_CODE, evaluateLiveCheckIn, exceptionForEmployee } from '@/lib/attendance-state';
import type { DayExceptionRecord } from '@/lib/day-status';
import { AttendanceMethod } from '@prisma/client';
import {
  isStaleMissingCheckout,
  STALE_MISSING_CHECKOUT_CODE,
  STALE_MISSING_CHECKOUT_ERROR,
  withShiftCheckoutWindow,
} from '@/lib/open-attendance';

/** Supervisor/Admin manual check-in or check-out */
export async function POST(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['ADMIN', 'HR', 'SUPERVISOR'].includes(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || ''); // check-in | check-out
  const employeeId = String(body.employeeId || '');
  const reason = String(body.reason || '').trim();
  const at = body.at ? new Date(body.at) : new Date();

  if (!employeeId || !reason) {
    return NextResponse.json({ error: 'employeeId and reason required' }, { status: 400 });
  }

  if (action === 'check-in') {
    const now = new Date();
    const lookup = await getTonightAssignment(employeeId, now);
    const assignment = lookup.assignment
      ? await prisma.employeeShiftAssignment.findUnique({
          where: { id: lookup.assignment.id },
          include: { shift: true, project: true },
        })
      : null;

    const openRecords = await prisma.attendanceRecord.findMany({
      where: { employeeId, checkOutAt: null, checkInAt: { not: null } },
      include: { shift: true },
    });
    const exceptionRows = assignment
      ? await prisma.dayException.findMany({
          where: {
            workDate: assignment.workDate,
            OR: [{ employeeId }, { employeeId: null, type: 'HOLIDAY' }],
          },
        })
      : [];
    const exception = assignment
      ? exceptionForEmployee(
          assignment.workDate,
          employeeId,
          exceptionRows.map((row) => ({
            workDate: row.workDate,
            employeeId: row.employeeId,
            type: row.type as DayExceptionRecord['type'],
            expectedStartTime: row.expectedStartTime,
            expectedEndTime: row.expectedEndTime,
            expectedWorkMinutes: row.expectedWorkMinutes,
          }))
        )
      : null;
    const decision = evaluateLiveCheckIn({
      scheduleKind: lookup.kind,
      now,
      workDate: assignment?.workDate || lookup.workDate,
      startTime: assignment?.shift.startTime || '15:30',
      endTime: assignment?.shift.endTime || '03:30',
      crossesMidnight: assignment?.shift.crossesMidnight ?? true,
      checkinWindowBeforeMinutes: assignment?.shift.checkinWindowBeforeMinutes,
      exception,
      openRecords: openRecords.map((row) => withShiftCheckoutWindow(row)),
    });
    if (!decision.ok) {
      return NextResponse.json(
        {
          error: decision.error,
          code: decision.code,
          minutesUntilOpen: decision.minutesUntilOpen,
          opensAt: decision.opensAt,
        },
        { status: decision.code === CURRENT_OPEN_CODE ? 409 : 403 }
      );
    }
    if (!assignment) {
      return NextResponse.json({ error: 'No shift scheduled. Contact supervisor.', code: 'NO_SCHEDULE' }, { status: 403 });
    }
    const { scheduledStart, scheduledEnd } = decision;

    const calc = calculateAttendance({
      scheduledStart,
      scheduledEnd,
      checkInAt: now,
      checkOutAt: null,
      gracePeriodMinutes: assignment.shift.gracePeriodMinutes,
      manualCheckIn: true,
    });

    const record = await prisma.attendanceRecord.create({
      data: {
        employeeId,
        projectId: assignment.projectId,
        shiftId: assignment.shiftId,
        assignmentId: assignment.id,
        scheduledStart,
        scheduledEnd,
        checkInAt: now,
        checkInMethod: AttendanceMethod.MANUAL,
        lateMinutes: calc.lateMinutes,
        flags: JSON.stringify(calc.flags),
        statusPrimary: calc.statusPrimary,
        manualOverride: true,
      },
    });

    await prisma.attendanceAdjustment.create({
      data: {
        attendanceId: record.id,
        field: 'checkInAt',
        oldValue: null,
        newValue: now.toISOString(),
        reason,
        changedById: auth.sub,
      },
    });

    await writeAudit({
      actorId: auth.sub,
      action: 'MANUAL_CHECK_IN',
      entityType: 'AttendanceRecord',
      entityId: record.id,
      employeeId,
      newValue: { at: now, reason },
    });

    return NextResponse.json({ ok: true, record });
  }

  if (action === 'check-out') {
    const attendanceId = String(body.attendanceId || '');
    const open = attendanceId
      ? await prisma.attendanceRecord.findUnique({
          where: { id: attendanceId },
          include: { shift: true },
        })
      : await prisma.attendanceRecord.findFirst({
          where: { employeeId, checkInAt: { not: null }, checkOutAt: null },
          include: { shift: true },
        });

    if (!open || !open.checkInAt) {
      return NextResponse.json({ error: 'No open attendance' }, { status: 404 });
    }
    if (open.checkOutAt) {
      return NextResponse.json({ error: 'Attendance already has a checkout' }, { status: 409 });
    }
    const classified = withShiftCheckoutWindow(open);
    if (isStaleMissingCheckout(classified, new Date())) {
      return NextResponse.json(
        { error: STALE_MISSING_CHECKOUT_ERROR, code: STALE_MISSING_CHECKOUT_CODE },
        { status: 409 }
      );
    }

    const calc = calculateAttendance({
      scheduledStart: open.scheduledStart,
      scheduledEnd: open.scheduledEnd,
      checkInAt: open.checkInAt,
      checkOutAt: at,
      gracePeriodMinutes: open.shift.gracePeriodMinutes,
      manualCheckIn: open.checkInMethod === 'MANUAL',
      manualCheckOut: true,
    });

    const updated = await prisma.attendanceRecord.update({
      where: { id: open.id },
      data: {
        checkOutAt: at,
        checkOutMethod: AttendanceMethod.MANUAL,
        workedMinutes: calc.workedMinutes,
        lateMinutes: calc.lateMinutes,
        earlyLeaveMinutes: calc.earlyLeaveMinutes,
        overtimeMinutes: calc.overtimeMinutes,
        flags: JSON.stringify(calc.flags),
        statusPrimary: calc.statusPrimary,
        manualOverride: true,
      },
    });

    await prisma.attendanceAdjustment.create({
      data: {
        attendanceId: open.id,
        field: 'checkOutAt',
        oldValue: null,
        newValue: at.toISOString(),
        reason,
        changedById: auth.sub,
      },
    });

    await writeAudit({
      actorId: auth.sub,
      action: 'MANUAL_CHECK_OUT',
      entityType: 'AttendanceRecord',
      entityId: open.id,
      employeeId,
      newValue: { at, reason },
    });

    return NextResponse.json({ ok: true, record: updated });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
