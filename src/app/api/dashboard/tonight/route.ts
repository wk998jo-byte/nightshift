import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { resolveWorkDateForShift } from '@/lib/attendance-calc';

export async function GET(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['ADMIN', 'HR', 'SUPERVISOR', 'SECURITY'].includes(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const night = await prisma.shift.findFirst({
    where: { crossesMidnight: true, isActive: true },
  });
  const workDate =
    req.nextUrl.searchParams.get('date') ||
    (night
      ? resolveWorkDateForShift(new Date(), night.startTime, night.endTime, true)
      : new Date().toISOString().slice(0, 10));

  const projectId = req.nextUrl.searchParams.get('projectId') || undefined;

  const assignments = await prisma.employeeShiftAssignment.findMany({
    where: {
      workDate,
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

  const records = await prisma.attendanceRecord.findMany({
    where: {
      assignment: { workDate },
      ...(projectId ? { projectId } : {}),
    },
    include: { employee: true, project: true },
    orderBy: { checkInAt: 'desc' },
  });

  const scheduled = assignments.length;
  const present = records.filter((r) => r.checkInAt).length;
  const late = records.filter((r) => r.lateMinutes > 0).length;
  const overtime = records.filter((r) => r.overtimeMinutes > 0).length;
  const missingCheckout = records.filter((r) => r.checkInAt && !r.checkOutAt).length;
  const working = missingCheckout;
  const checkedInIds = new Set(records.map((r) => r.employeeId));
  const absent = assignments.filter((a) => !checkedInIds.has(a.employeeId)).length;

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
      scheduled,
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
    assignments: assignments.map((a) => ({
      employeeName: a.employee.fullName,
      employeeCode: a.employee.employeeCode,
      project: a.project.name,
      hasAttendance: a.attendance.length > 0,
    })),
  });
}
