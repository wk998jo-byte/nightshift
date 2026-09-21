import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { formatDuration, formatTime } from '@/lib/attendance-calc';

export async function GET(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['ADMIN', 'HR', 'SUPERVISOR'].includes(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const workDate = req.nextUrl.searchParams.get('date');
  const projectId = req.nextUrl.searchParams.get('projectId') || undefined;
  const status = req.nextUrl.searchParams.get('status') || undefined;

  const records = await prisma.attendanceRecord.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(status ? { statusPrimary: status } : {}),
      ...(workDate ? { assignment: { workDate } } : {}),
    },
    include: { employee: true, project: true },
    orderBy: { scheduledStart: 'desc' },
    take: 500,
  });

  const header = [
    'Employee',
    'Employee ID',
    'Project',
    'Check-in',
    'Check-out',
    'Worked',
    'Late (min)',
    'OT (min)',
    'Early (min)',
    'Status',
    'Flags',
  ];

  const rows = records.map((r) =>
    [
      r.employee.fullName,
      r.employee.employeeCode,
      r.project.name,
      formatTime(r.checkInAt),
      formatTime(r.checkOutAt),
      formatDuration(r.workedMinutes),
      r.lateMinutes,
      r.overtimeMinutes,
      r.earlyLeaveMinutes,
      r.statusPrimary,
      (JSON.parse(r.flags || '[]') as string[]).join('|'),
    ]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(',')
  );

  const csv = [header.join(','), ...rows].join('\n');
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="attendance-${workDate || 'all'}.csv"`,
    },
  });
}
