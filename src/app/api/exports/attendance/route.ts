import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  buildExportRows,
  canExportAttendance,
  exportFilename,
  parseExportRange,
  rowsToCsv,
} from '@/lib/attendance-export';

export async function GET(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canExportAttendance(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const range = parseExportRange({
    from: params.get('from'),
    to: params.get('to'),
    date: params.get('date'),
  });
  if (!range.ok) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }

  const projectId = params.get('projectId') || undefined;
  const assignments = await prisma.employeeShiftAssignment.findMany({
    where: {
      status: { in: ['SCHEDULED', 'OFF'] },
      workDate: { gte: range.from, lte: range.to },
      ...(projectId ? { projectId } : {}),
    },
    include: {
      employee: { include: { user: { select: { role: true, isActive: true } } } },
      project: true,
      shift: true,
      attendance: true,
    },
    orderBy: [{ workDate: 'asc' }, { employeeId: 'asc' }],
  });

  const csv = rowsToCsv(buildExportRows(assignments, new Date()));
  const filename = exportFilename(range.from, range.to);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
