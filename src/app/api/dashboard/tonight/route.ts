import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { boardWorkDate, buildTonightBoard, pickActiveTerminal } from '@/lib/dashboard-board';
import { SHIFT_SCHEDULE_EMPLOYEE_WHERE } from '@/lib/shift-catalog';

export async function GET(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['ADMIN', 'HR', 'SUPERVISOR', 'SECURITY'].includes(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date();
  const workDate = boardWorkDate(now, req.nextUrl.searchParams.get('date'));
  const projectId = req.nextUrl.searchParams.get('projectId') || undefined;

  const [assignments, exceptions] = await Promise.all([
    prisma.employeeShiftAssignment.findMany({
      where: {
        workDate,
        ...(projectId ? { projectId } : {}),
      },
      include: {
        employee: { include: { user: { select: { role: true, isActive: true } } } },
        project: true,
        shift: true,
        attendance: true,
      },
    }),
    prisma.dayException.findMany({ where: { workDate } }),
  ]);

  const board = buildTonightBoard({
    workDate,
    now,
    assignments,
    exceptions: exceptions.map((row) => ({
      workDate: row.workDate,
      employeeId: row.employeeId,
      type: row.type,
      reason: row.reason,
      expectedStartTime: row.expectedStartTime,
      expectedEndTime: row.expectedEndTime,
      expectedWorkMinutes: row.expectedWorkMinutes,
    })),
  });
  const terminalRow = await prisma.qrTerminal.findFirst({
    where: { isActive: true, project: { isActive: true } },
    orderBy: { createdAt: 'asc' },
  });
  const qrTerminal = pickActiveTerminal(terminalRow ? [terminalRow] : []);

  const activeEmployees = await prisma.employee.findMany({
    where: SHIFT_SCHEDULE_EMPLOYEE_WHERE,
    orderBy: { fullName: 'asc' },
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      badgeNumber: true,
    },
  });

  return NextResponse.json({
    workDate,
    summary: {
      scheduled: board.scheduled.length,
      present: board.present,
      late: board.late,
      absent: board.absent,
      overtime: board.overtime,
      missingCheckout: board.missingCheckout,
      working: board.working,
    },
    currentlyWorking: board.currentlyWorking,
    records: board.rows,
    absent: board.absentRows,
    qrTerminal,
    activeEmployees,
  });
}
