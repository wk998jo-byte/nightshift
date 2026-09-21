import { isDemoEmployeeCode, isDemoEmployeeName } from './demo-employee';
import { describeUserAgent, displayDeviceId } from './device-display';
import { isShiftScheduleEmployee } from './shift-catalog';

export type DeviceRow = {
  id: string;
  employeeId: string | null;
  deviceFingerprint: string;
  userAgent: string | null;
  flagged: boolean;
};

export type DeviceEmployee = {
  id: string;
  fullName: string;
  employeeCode: string;
  isActive: boolean;
  user?: { role: string; isActive: boolean } | null;
};

export type DeviceWarning = 'NEW_DEVICE' | 'MULTI_ACCOUNT';

export type DeviceDecision = {
  action: 'create' | 'touch' | 'flag-multi';
  isNewDeviceForEmployee: boolean;
  warnNewDevice: boolean;
  warnMultiAccount: boolean;
  flagDevice: boolean;
  reassign: false;
  previousEmployeeId: string | null;
};

export type DeviceDb = {
  device: {
    findFirst: (args?: any) => Promise<DeviceRow | null>;
    findMany: (args?: any) => Promise<DeviceRow[]>;
    create: (args?: any) => Promise<DeviceRow>;
    update: (args?: any) => Promise<DeviceRow>;
  };
  employee: {
    findUnique: (args?: any) => Promise<DeviceEmployee | null>;
  };
};

/** Real active employees only. Demo / inactive rows must not drive warnings. */
export function isSecurityRelevantEmployee(person: DeviceEmployee | null | undefined): boolean {
  if (!person) return false;
  if (isDemoEmployeeCode(person.employeeCode) || isDemoEmployeeName(person.fullName)) return false;
  return isShiftScheduleEmployee({
    isActive: person.isActive,
    user: person.user ?? null,
  });
}

export function decideDeviceSecurity(input: {
  employee: DeviceEmployee;
  existingDevice: DeviceRow | null;
  previousDevicesForEmployee: DeviceRow[];
  previousOwner: DeviceEmployee | null;
}): DeviceDecision {
  const relevantPrevious = input.previousDevicesForEmployee.filter((d) => d.deviceFingerprint);
  const ownedByCurrent =
    !!input.existingDevice && input.existingDevice.employeeId === input.employee.id;
  const isNewDeviceForEmployee = !ownedByCurrent;
  const warnNewDevice = isNewDeviceForEmployee && relevantPrevious.length > 0;

  if (!input.existingDevice) {
    return {
      action: 'create',
      isNewDeviceForEmployee: true,
      warnNewDevice,
      warnMultiAccount: false,
      flagDevice: false,
      reassign: false,
      previousEmployeeId: null,
    };
  }

  if (ownedByCurrent || !input.existingDevice.employeeId) {
    return {
      action: 'touch',
      isNewDeviceForEmployee,
      warnNewDevice,
      warnMultiAccount: false,
      flagDevice: input.existingDevice.flagged,
      reassign: false,
      previousEmployeeId: input.existingDevice.employeeId,
    };
  }

  const otherIsRelevant = isSecurityRelevantEmployee(input.previousOwner);
  return {
    action: otherIsRelevant ? 'flag-multi' : 'touch',
    isNewDeviceForEmployee: true,
    warnNewDevice,
    warnMultiAccount: otherIsRelevant,
    flagDevice: otherIsRelevant || input.existingDevice.flagged,
    reassign: false,
    previousEmployeeId: input.existingDevice.employeeId,
  };
}

export async function observePunchDevice(
  db: DeviceDb,
  input: {
    employee: DeviceEmployee;
    fingerprint: string;
    userAgent: string | null;
    now?: Date;
  }
): Promise<{
  device: DeviceRow;
  warnings: DeviceWarning[];
  previousEmployeeId: string | null;
  previousEmployeeName: string | null;
  previousEmployeeCode: string | null;
  displayDeviceId: string;
  deviceType: string;
}> {
  const now = input.now || new Date();
  const existing = await db.device.findFirst({
    where: { deviceFingerprint: input.fingerprint },
  });
  const previousDevicesForEmployee = await db.device.findMany({
    where: {
      employeeId: input.employee.id,
      deviceFingerprint: { not: input.fingerprint },
    },
  });
  let previousOwner: DeviceEmployee | null = null;
  if (existing?.employeeId && existing.employeeId !== input.employee.id) {
    previousOwner = await db.employee.findUnique({
      where: { id: existing.employeeId },
      include: { user: { select: { role: true, isActive: true } } },
    });
  }

  const decision = decideDeviceSecurity({
    employee: input.employee,
    existingDevice: existing,
    previousDevicesForEmployee,
    previousOwner,
  });

  let device: DeviceRow;
  if (!existing) {
    device = await db.device.create({
      data: {
        employeeId: input.employee.id,
        deviceFingerprint: input.fingerprint,
        userAgent: input.userAgent,
        lastSeenAt: now,
      },
    });
  } else if (decision.action === 'flag-multi') {
    device = await db.device.update({
      where: { id: existing.id },
      data: { flagged: true, lastSeenAt: now, userAgent: input.userAgent || existing.userAgent },
    });
  } else if (!existing.employeeId) {
    device = await db.device.update({
      where: { id: existing.id },
      data: {
        employeeId: input.employee.id,
        lastSeenAt: now,
        userAgent: input.userAgent || existing.userAgent,
        flagged: decision.flagDevice,
      },
    });
  } else {
    device = await db.device.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        userAgent: input.userAgent || existing.userAgent,
        flagged: decision.flagDevice,
      },
    });
  }

  const warnings: DeviceWarning[] = [];
  if (decision.warnNewDevice) warnings.push('NEW_DEVICE');
  if (decision.warnMultiAccount) warnings.push('MULTI_ACCOUNT');

  return {
    device,
    warnings,
    previousEmployeeId: decision.warnMultiAccount ? decision.previousEmployeeId : null,
    previousEmployeeName: decision.warnMultiAccount ? previousOwner?.fullName || null : null,
    previousEmployeeCode: decision.warnMultiAccount ? previousOwner?.employeeCode || null : null,
    displayDeviceId: displayDeviceId(input.fingerprint),
    deviceType: describeUserAgent(input.userAgent),
  };
}

export function securityAuditPayload(input: {
  operation: 'check-in' | 'check-out';
  employee: DeviceEmployee;
  device: DeviceRow;
  ip: string | null;
  userAgent: string | null;
  previousEmployeeId?: string | null;
  previousEmployeeName?: string | null;
  previousEmployeeCode?: string | null;
  attendanceId?: string;
}) {
  return {
    operation: input.operation,
    employeeId: input.employee.id,
    employeeName: input.employee.fullName,
    employeeCode: input.employee.employeeCode,
    deviceId: input.device.id,
    displayDeviceId: displayDeviceId(input.device.deviceFingerprint),
    deviceType: describeUserAgent(input.userAgent || input.device.userAgent),
    ip: input.ip,
    previousEmployeeId: input.previousEmployeeId || undefined,
    previousEmployeeName: input.previousEmployeeName || undefined,
    previousEmployeeCode: input.previousEmployeeCode || undefined,
  };
}

export async function recordDeviceWarnings(
  writeAudit: (input: {
    actorId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    employeeId?: string;
    oldValue?: unknown;
    newValue?: unknown;
    ip?: string | null;
    userAgent?: string | null;
  }) => Promise<void>,
  input: {
    actorId: string;
    attendanceId: string;
    ip: string | null;
    userAgent: string | null;
    observed: Awaited<ReturnType<typeof observePunchDevice>>;
    employee: DeviceEmployee;
    operation: 'check-in' | 'check-out';
  }
) {
  if (input.observed.warnings.length === 0) return;
  const payload = securityAuditPayload({
    operation: input.operation,
    employee: input.employee,
    device: input.observed.device,
    ip: input.ip,
    userAgent: input.userAgent,
    previousEmployeeId: input.observed.previousEmployeeId,
    previousEmployeeName: input.observed.previousEmployeeName,
    previousEmployeeCode: input.observed.previousEmployeeCode,
    attendanceId: input.attendanceId,
  });
  for (const warning of input.observed.warnings) {
    await writeAudit({
      actorId: input.actorId,
      action: warning === 'NEW_DEVICE' ? 'SECURITY_NEW_DEVICE' : 'SECURITY_DEVICE_MULTI_ACCOUNT',
      entityType: 'AttendanceRecord',
      entityId: input.attendanceId,
      employeeId: input.employee.id,
      newValue: payload,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }
}
