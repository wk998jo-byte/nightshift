import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { isInsideRadius } from '@/lib/geo';
import { calculateAttendance } from '@/lib/attendance-calc';
import { getTonightAssignment } from '@/lib/schedule';
import { checkInDeniedReason } from '@/lib/schedule-lookup';
import { getShiftTiming } from '@/lib/schedule-timing';
import { fingerprintFromRequest, hashToken, verifyQrToken } from '@/lib/security';
import { observePunchDevice, recordDeviceWarnings } from '@/lib/device-security';
import { AttendanceMethod } from '@prisma/client';

type Body = {
  token?: string;
  latitude?: number;
  longitude?: number;
  deviceId?: string;
};

async function validateQrAndLocation(body: Body, req: NextRequest) {
  if (body.latitude == null || body.longitude == null) {
    return { error: 'GPS location is required', status: 400 as const };
  }
  if (!body.token) return { error: 'QR token required', status: 400 as const };

  const parsed = verifyQrToken(body.token);
  if (!parsed.ok || !parsed.sessionId || !parsed.projectId) {
    return { error: parsed.reason || 'Invalid QR', status: 400 as const };
  }

  const session = await prisma.qrSession.findUnique({ where: { id: parsed.sessionId } });
  if (!session || session.revokedAt) {
    return { error: 'QR session invalid', status: 400 as const };
  }
  if (session.expiresAt.getTime() < Date.now()) {
    return { error: 'Expired QR', status: 400 as const };
  }
  if (session.tokenHash !== hashToken(body.token)) {
    return { error: 'QR mismatch', status: 400 as const };
  }

  const project = await prisma.project.findUnique({ where: { id: parsed.projectId } });
  if (!project || !project.isActive) {
    return { error: 'Project inactive', status: 400 as const };
  }

  const geo = isInsideRadius(
    body.latitude,
    body.longitude,
    project.latitude,
    project.longitude,
    project.radiusMeters
  );
  if (!geo.inside) {
    return {
      error: `You are outside the work site (${geo.distance}m away, allowed ${project.radiusMeters}m)`,
      status: 403 as const,
      distance: geo.distance,
    };
  }

  return {
    project,
    qrSession: session,
    ip: req.headers.get('x-forwarded-for'),
    ua: req.headers.get('user-agent'),
    fingerprint: fingerprintFromRequest(req.headers.get('user-agent'), body.deviceId),
  };
}

export async function POST(req: NextRequest) {
  const auth = await getSession();
  if (!auth || !auth.employeeId) {
    return NextResponse.json({ error: 'Login required' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const validated = await validateQrAndLocation(body, req);
  if ('error' in validated && validated.error) {
    return NextResponse.json(
      { error: validated.error, distance: 'distance' in validated ? validated.distance : undefined },
      { status: validated.status }
    );
  }

  const { project, qrSession, ip, ua, fingerprint } = validated as Exclude<
    typeof validated,
    { error: string }
  >;

  const employee = await prisma.employee.findUnique({
    where: { id: auth.employeeId },
    include: { user: { select: { role: true, isActive: true } } },
  });
  if (!employee || !employee.isActive) {
    return NextResponse.json({ error: 'Employee inactive' }, { status: 403 });
  }

  const open = await prisma.attendanceRecord.findFirst({
    where: { employeeId: employee.id, checkInAt: { not: null }, checkOutAt: null },
  });
  if (open) {
    return NextResponse.json(
      { error: 'You already have an open shift. End it first.' },
      { status: 409 }
    );
  }

  // Check-in is allowed only for an admin-assigned schedule. QR does not pick a shift.
  const lookup = await getTonightAssignment(employee.id, new Date());
  const denied = checkInDeniedReason(lookup.kind);
  if (denied) {
    return NextResponse.json({ error: denied.error, code: denied.code }, { status: 403 });
  }
  if (!lookup.assignment || !lookup.window) {
    return NextResponse.json({ error: 'No shift scheduled. Contact supervisor.' }, { status: 403 });
  }

  const assignment = lookup.assignment;
  if (assignment.projectId !== project.id) {
    return NextResponse.json(
      { error: 'QR is for a different project than your schedule' },
      { status: 403 }
    );
  }

  const shift = assignment.shift;
  const { scheduledStart, scheduledEnd } = lookup.window;
  const now = new Date();

  // Allow early start — no hard block before shift start
  const timingAtPunch = getShiftTiming(
    now,
    scheduledStart,
    scheduledEnd,
    shift.gracePeriodMinutes
  );

  const calc = calculateAttendance({
    scheduledStart,
    scheduledEnd,
    checkInAt: now,
    checkOutAt: null,
    gracePeriodMinutes: shift.gracePeriodMinutes,
  });

  // If early, mark as on-time present (not late)
  if (timingAtPunch.phase === 'early') {
    calc.lateMinutes = 0;
    calc.flags = calc.flags.filter((f) => f !== 'LATE');
    if (!calc.flags.includes('ON_TIME')) calc.flags.push('ON_TIME');
    calc.statusPrimary = 'ON_TIME';
  }

  const observed = await observePunchDevice(prisma, {
    employee,
    fingerprint,
    userAgent: ua,
    now,
  });
  const device = observed.device;

  const record = await prisma.attendanceRecord.create({
    data: {
      employeeId: employee.id,
      projectId: project.id,
      shiftId: shift.id,
      assignmentId: assignment.id,
      scheduledStart,
      scheduledEnd,
      checkInAt: now,
      checkInLatitude: body.latitude!,
      checkInLongitude: body.longitude!,
      checkInMethod: AttendanceMethod.QR,
      checkInQrSessionId: qrSession.id,
      checkInDeviceId: device.id,
      checkInIp: ip,
      lateMinutes: calc.lateMinutes,
      flags: JSON.stringify(calc.flags),
      statusPrimary: calc.statusPrimary,
    },
  });

  await writeAudit({
    actorId: auth.sub,
    action: 'CHECK_IN',
    entityType: 'AttendanceRecord',
    entityId: record.id,
    employeeId: employee.id,
    newValue: {
      checkInAt: now,
      projectId: project.id,
      lateMinutes: calc.lateMinutes,
      timing: timingAtPunch.phase,
      displayDeviceId: observed.displayDeviceId,
    },
    ip,
    userAgent: ua,
  });
  await recordDeviceWarnings(writeAudit, {
    actorId: auth.sub,
    attendanceId: record.id,
    ip,
    userAgent: ua,
    observed,
    employee,
    operation: 'check-in',
  });

  let message = 'تم تسجيل حضورك بنجاح';
  if (timingAtPunch.phase === 'early') {
    message = `تم تسجيل حضورك مبكراً · باقي ${timingAtPunch.minutesUntilStart} دقيقة على بداية الشفت`;
  } else if (timingAtPunch.phase === 'late') {
    message = `تم تسجيل حضورك · متأخر ${timingAtPunch.lateMinutes} دقيقة`;
  } else {
    message = 'تم تسجيل حضورك في الوقت';
  }

  return NextResponse.json({
    ok: true,
    message,
    attendance: {
      id: record.id,
      employeeName: employee.fullName,
      employeeCode: employee.employeeCode,
      project: project.name,
      checkInAt: now.toISOString(),
      scheduledStart: scheduledStart.toISOString(),
      scheduledEnd: scheduledEnd.toISOString(),
      lateMinutes: calc.lateMinutes,
      earlyMinutes: timingAtPunch.earlyMinutes,
      timingPhase: timingAtPunch.phase,
      timingLabel: timingAtPunch.labelAr,
      flags: calc.flags,
    },
  });
}
