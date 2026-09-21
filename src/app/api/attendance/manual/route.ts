import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { calculateAttendance, scheduledWindow } from '@/lib/attendance-calc';
import { AttendanceMethod } from '@prisma/client';

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
    const assignmentId = String(body.assignmentId || '');
    const assignment = assignmentId
      ? await prisma.employeeShiftAssignment.findUnique({
          where: { id: assignmentId },
          include: { shift: true, project: true },
        })
      : await prisma.employeeShiftAssignment.findFirst({
          where: { employeeId, status: 'SCHEDULED' },
          orderBy: { workDate: 'desc' },
          include: { shift: true, project: true },
        });

    if (!assignment) {
      return NextResponse.json({ error: 'No assignment found' }, { status: 404 });
    }

    const open = await prisma.attendanceRecord.findFirst({
      where: { employeeId, checkOutAt: null, checkInAt: { not: null } },
    });
    if (open) {
      return NextResponse.json({ error: 'Open shift already exists' }, { status: 409 });
    }

    const { scheduledStart, scheduledEnd } = scheduledWindow(
      assignment.workDate,
      assignment.shift.startTime,
      assignment.shift.endTime,
      assignment.shift.crossesMidnight
    );

    const calc = calculateAttendance({
      scheduledStart,
      scheduledEnd,
      checkInAt: at,
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
        checkInAt: at,
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
        newValue: at.toISOString(),
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
      newValue: { at, reason },
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
