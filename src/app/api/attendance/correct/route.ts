import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canManageSchedule } from '@/lib/shift-catalog';
import { catalogFromShifts } from '@/lib/shift-catalog';
import { applyAttendanceCorrection, parseAppDateTime } from '@/lib/attendance-correction';

export async function POST(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageSchedule(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const employeeId = String(body.employeeId || '');
  const workDate = String(body.workDate || '');
  const choice = body.choice ? String(body.choice) : undefined;
  const reason = String(body.reason || '');
  const checkInAt = parseAppDateTime(workDate, String(body.checkInAt || ''));
  const checkOutRaw = String(body.checkOutAt || '').trim();
  const checkOutAt = checkOutRaw ? parseAppDateTime(workDate, checkOutRaw) : null;

  if (!employeeId || !workDate) {
    return NextResponse.json({ error: 'employeeId and workDate are required' }, { status: 400 });
  }
  if (!checkInAt) return NextResponse.json({ error: 'Valid check-in is required' }, { status: 400 });
  if (checkOutRaw && !checkOutAt) {
    return NextResponse.json({ error: 'Invalid check-out' }, { status: 400 });
  }

  const shifts = await prisma.shift.findMany({ where: { isActive: true } });
  const catalog = catalogFromShifts(shifts);
  const result = await applyAttendanceCorrection({
    db: prisma,
    catalog,
    actorId: auth.sub,
    employeeId,
    workDate,
    choice,
    checkInAt,
    checkOutAt,
    reason,
    writeAudit,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    ok: true,
    record: result.record,
    assignment: { id: result.assignment.id, workDate, shiftId: result.assignment.shiftId },
    calc: result.calc,
  });
}
