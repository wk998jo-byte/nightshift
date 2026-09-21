import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { buildAttendanceDetails, canViewAttendanceDetails } from '@/lib/attendance-details';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewAttendanceDetails(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!id || id.startsWith('absent:')) {
    return NextResponse.json({ error: 'Attendance record not found' }, { status: 404 });
  }

  const record = await prisma.attendanceRecord.findUnique({
    where: { id },
    include: {
      employee: { include: { user: { select: { role: true, isActive: true } } } },
      project: true,
      shift: true,
    },
  });
  if (!record) return NextResponse.json({ error: 'Attendance record not found' }, { status: 404 });

  const deviceIds = [record.checkInDeviceId, record.checkOutDeviceId].filter(
    (value): value is string => !!value
  );
  const devices = deviceIds.length
    ? await prisma.device.findMany({ where: { id: { in: deviceIds } } })
    : [];
  const byId = new Map(devices.map((d) => [d.id, d]));

  const audits = await prisma.auditLog.findMany({
    where: {
      entityId: record.id,
      action: { in: ['SECURITY_NEW_DEVICE', 'SECURITY_DEVICE_MULTI_ACCOUNT'] },
    },
    select: { action: true },
  });

  const details = buildAttendanceDetails({
    id: record.id,
    employee: record.employee,
    project: record.project,
    shift: record.shift,
    checkInAt: record.checkInAt,
    checkOutAt: record.checkOutAt,
    checkInMethod: record.checkInMethod,
    checkOutMethod: record.checkOutMethod,
    checkInLatitude: record.checkInLatitude,
    checkInLongitude: record.checkInLongitude,
    checkOutLatitude: record.checkOutLatitude,
    checkOutLongitude: record.checkOutLongitude,
    checkInIp: record.checkInIp,
    checkOutIp: record.checkOutIp,
    checkInDevice: record.checkInDeviceId ? byId.get(record.checkInDeviceId) || null : null,
    checkOutDevice: record.checkOutDeviceId ? byId.get(record.checkOutDeviceId) || null : null,
    audits,
  });

  return NextResponse.json({ details });
}
