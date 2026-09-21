import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { scheduledWindow } from '@/lib/attendance-calc';
import { calendarDateInAppZone } from '@/lib/timezone';
import { countAbsent, relevantWorkDatesForBoard } from '@/lib/schedule-service';

export async function GET(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['ADMIN', 'HR', 'SUPERVISOR', 'SECURITY'].includes(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date();
  const today = calendarDateInAppZone(now);
  const workDate = req.nextUrl.searchParams.get('date') || today;
  const projectId = req.nextUrl.searchParams.get('projectId') || undefined;
  const boardDates = req.nextUrl.searchParams.get('date')
    ? [workDate]
    : relevantWorkDatesForBoard(now);

  const assignments = await prisma.employeeShiftAssignment.findMany({
    where: {
      workDate: { in: boardDates },
      status: 'SCHEDULED',
      ...(projectId ? { projectId } : {}),
    },
    include: {
      employee: true,
      project: true,
      shift: true,
      attendance: true,
    },
  });

  const visibleAssignments = assignments.filter((a) => {
    if (a.workDate === workDate) return true;
    const window = scheduledWindow(
      a.workDate,
      a.shift.startTime,
      a.shift.endTime,
      a.shift.crossesMidnight
    );
    return now < window.scheduledEnd;
  });

  const records = await prisma.attendanceRecord.findMany({
    where: {
      assignment: { workDate: { in: boardDates } },
      ...(projectId ? { projectId } : {}),
    },
    include: { employee: true, project: true, assignment: { select: { workDate: true } } },
    orderBy: { checkInAt: 'desc' },
  });

  const checkedInIds = new Set(
    records
      .filter((r) => r.checkInAt)
      .map((r) => `${r.employeeId}:${r.assignment?.workDate || calendarDateInAppZone(r.scheduledStart)}`)
  );
  const present = records.filter((r) => r.checkInAt).length;
  const late = records.filter((r) => r.lateMinutes > 0).length;
  const overtime = records.filter((r) => r.overtimeMinutes > 0).length;
  const missingCheckout = records.filter((r) => r.checkInAt && !r.checkOutAt).length;
  const working = missingCheckout;
  const absent = countAbsent({
    assignments: visibleAssignments,
    checkedInIds,
    now,
  });

  const currentlyWorking = records
    .filter((r) => r.checkInAt && !r.checkOutAt)
    .map((r) => ({
      id: r.id,
      name: r.employee.fullName,
      code: r.employee.employeeCode,
      project: r.project.name,
      checkInAt: r.checkInAt,
      lateMinutes: r.lateMinutes,
      currentWorkedMinutes: r.checkInAt
        ? Math.floor((Date.now() - r.checkInAt.getTime()) / 60000)
        : 0,
    }));

  return NextResponse.json({
    workDate,
    summary: {
      scheduled: visibleAssignments.length,
      present,
      late,
      absent,
      overtime,
      missingCheckout,
      working,
    },
    currentlyWorking,
    records: records.map((r) => ({
      id: r.id,
      employeeName: r.employee.fullName,
      employeeCode: r.employee.employeeCode,
      project: r.project.name,
      checkInAt: r.checkInAt,
      checkOutAt: r.checkOutAt,
      workedMinutes: r.workedMinutes,
      lateMinutes: r.lateMinutes,
      overtimeMinutes: r.overtimeMinutes,
      earlyLeaveMinutes: r.earlyLeaveMinutes,
      statusPrimary: r.statusPrimary,
      flags: JSON.parse(r.flags || '[]'),
      manualOverride: r.manualOverride,
    })),
    assignments: visibleAssignments.map((a) => ({
      employeeName: a.employee.fullName,
      employeeCode: a.employee.employeeCode,
      project: a.project.name,
      hasAttendance: a.attendance.length > 0,
    })),
  });
}
