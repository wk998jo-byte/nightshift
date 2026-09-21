import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { isInsideRadius } from '@/lib/geo';
import { calculateAttendance } from '@/lib/attendance-calc';
import { fingerprintFromRequest, hashToken, verifyQrToken } from '@/lib/security';
import { observePunchDevice, recordDeviceWarnings } from '@/lib/device-security';
import { AttendanceMethod } from '@prisma/client';

export async function POST(req: NextRequest) {
  const auth = await getSession();
  if (!auth || !auth.employeeId) {
    return NextResponse.json({ error: 'Login required' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const token = String(body.token || '');
  const latitude = body.latitude as number | undefined;
  const longitude = body.longitude as number | undefined;

  if (latitude == null || longitude == null) {
    return NextResponse.json({ error: 'GPS location is required' }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: 'QR token required' }, { status: 400 });

  const parsed = verifyQrToken(token);
  if (!parsed.ok || !parsed.sessionId || !parsed.projectId) {
    return NextResponse.json({ error: parsed.reason || 'Invalid QR' }, { status: 400 });
  }

  const qrSession = await prisma.qrSession.findUnique({ where: { id: parsed.sessionId } });
  if (!qrSession || qrSession.revokedAt || qrSession.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: 'Expired or invalid QR' }, { status: 400 });
  }
  if (qrSession.tokenHash !== hashToken(token)) {
    return NextResponse.json({ error: 'QR mismatch' }, { status: 400 });
  }

  const open = await prisma.attendanceRecord.findFirst({
    where: {
      employeeId: auth.employeeId,
      checkInAt: { not: null },
      checkOutAt: null,
    },
    include: { shift: true, project: true, employee: { include: { user: { select: { role: true, isActive: true } } } } },
  });
  if (!open) {
    return NextResponse.json({ error: 'No open shift to end' }, { status: 404 });
  }

  if (open.projectId !== parsed.projectId) {
    return NextResponse.json(
      { error: 'QR project does not match your open shift project' },
      { status: 403 }
    );
  }

  const geo = isInsideRadius(
    latitude,
    longitude,
    open.project.latitude,
    open.project.longitude,
    open.project.radiusMeters
  );
  if (!geo.inside) {
    return NextResponse.json(
      {
        error: `You are outside the work site (${geo.distance}m away, allowed ${open.project.radiusMeters}m)`,
      },
      { status: 403 }
    );
  }

  const now = new Date();
  const calc = calculateAttendance({
    scheduledStart: open.scheduledStart,
    scheduledEnd: open.scheduledEnd,
    checkInAt: open.checkInAt,
    checkOutAt: now,
    gracePeriodMinutes: open.shift.gracePeriodMinutes,
    manualCheckIn: open.checkInMethod === 'MANUAL',
  });

  const ua = req.headers.get('user-agent');
  const ip = req.headers.get('x-forwarded-for');
  const fingerprint = fingerprintFromRequest(ua, body.deviceId);
  const employee = open.employee;
  const observed = await observePunchDevice(prisma, {
    employee,
    fingerprint,
    userAgent: ua,
    now,
  });
  const device = observed.device;

  const updated = await prisma.attendanceRecord.update({
    where: { id: open.id },
    data: {
      checkOutAt: now,
      checkOutLatitude: latitude,
      checkOutLongitude: longitude,
      checkOutMethod: AttendanceMethod.QR,
      checkOutQrSessionId: qrSession.id,
      checkOutDeviceId: device.id,
      checkOutIp: ip,
      workedMinutes: calc.workedMinutes,
      lateMinutes: calc.lateMinutes,
      earlyLeaveMinutes: calc.earlyLeaveMinutes,
      overtimeMinutes: calc.overtimeMinutes,
      flags: JSON.stringify(calc.flags),
      statusPrimary: calc.statusPrimary,
    },
  });

  await writeAudit({
    actorId: auth.sub,
    action: 'CHECK_OUT',
    entityType: 'AttendanceRecord',
    entityId: updated.id,
    employeeId: auth.employeeId,
    newValue: {
      checkOutAt: now,
      workedMinutes: calc.workedMinutes,
      overtimeMinutes: calc.overtimeMinutes,
      displayDeviceId: observed.displayDeviceId,
    },
    ip,
    userAgent: ua,
  });
  await recordDeviceWarnings(writeAudit, {
    actorId: auth.sub,
    attendanceId: updated.id,
    ip,
    userAgent: ua,
    observed,
    employee,
    operation: 'check-out',
  });

  return NextResponse.json({
    ok: true,
    message: 'تم إنهاء الشفت بنجاح',
    attendance: {
      id: updated.id,
      employeeName: open.employee.fullName,
      employeeCode: open.employee.employeeCode,
      project: open.project.name,
      checkInAt: open.checkInAt,
      checkOutAt: now.toISOString(),
      workedMinutes: calc.workedMinutes,
      lateMinutes: calc.lateMinutes,
      earlyLeaveMinutes: calc.earlyLeaveMinutes,
      overtimeMinutes: calc.overtimeMinutes,
      flags: calc.flags,
    },
  });
}
