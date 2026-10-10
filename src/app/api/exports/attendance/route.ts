import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  buildExportRows,
  canExportAttendance,
  exportAssignmentWhere,
  exportFilename,
  parseExportRange,
  resolveExportEmployee,
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
  const rawEmployeeId = params.get('employeeId')?.trim() || '';
  let employeeCode: string | undefined;
  if (rawEmployeeId) {
    const employee = await prisma.employee.findUnique({
      where: { id: rawEmployeeId },
      include: { user: { select: { role: true, isActive: true } } },
    });
    const resolved = resolveExportEmployee(employee);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    employeeCode = resolved.employee.badgeNumber || resolved.employee.employeeCode;
  }

  const [assignments, exceptions] = await Promise.all([
    prisma.employeeShiftAssignment.findMany({
      where: exportAssignmentWhere({
        from: range.from,
        to: range.to,
        projectId,
        employeeId: rawEmployeeId || undefined,
      }),
      include: {
        employee: { include: { user: { select: { role: true, isActive: true } } } },
        project: true,
        shift: true,
        attendance: true,
      },
      orderBy: [{ workDate: 'asc' }, { employeeId: 'asc' }],
    }),
    prisma.dayException.findMany({
      where: { workDate: { gte: range.from, lte: range.to } },
    }),
  ]);

  const csv = rowsToCsv(
    buildExportRows(
      assignments,
      new Date(),
      exceptions.map((row) => ({
        workDate: row.workDate,
        employeeId: row.employeeId,
        type: row.type,
        reason: row.reason,
        expectedStartTime: row.expectedStartTime,
        expectedEndTime: row.expectedEndTime,
        expectedWorkMinutes: row.expectedWorkMinutes,
      })),
      rawEmployeeId ? { employeeId: rawEmployeeId } : undefined
    )
  );
  const filename = exportFilename(range.from, range.to, { employeeCode });
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
