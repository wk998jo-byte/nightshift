import { isInsideRadius } from './geo';
import {
  dash,
  describeUserAgent,
  displayDeviceId,
  formatGps,
  punchMapUrl,
} from './device-display';
import { shiftDisplayLabel } from './dashboard-board';
import { isSecurityRelevantEmployee, type DeviceEmployee, type DeviceRow } from './device-security';

export const ATTENDANCE_DETAILS_ROLES = ['ADMIN', 'HR', 'SUPERVISOR', 'SECURITY'] as const;

export function canViewAttendanceDetails(role: string | null | undefined): boolean {
  return !!role && (ATTENDANCE_DETAILS_ROLES as readonly string[]).includes(role);
}

export type PunchSide = {
  at: string | null;
  method: string | null;
  latitude: number | null;
  longitude: number | null;
  gps: string;
  distanceMeters: number | null;
  distanceLabel: string;
  radiusMeters: number;
  siteStatus: string;
  mapUrl: string | null;
  displayDeviceId: string;
  deviceType: string;
  ip: string;
  flagged: boolean;
};

export type AttendanceDetails = {
  id: string;
  employeeName: string;
  employeeCode: string;
  project: string;
  projectLocation: string | null;
  shiftLabel: string;
  checkIn: PunchSide;
  checkOut: PunchSide;
  security: {
    status: string;
    flags: string[];
    labels: string[];
  };
};

function emptyPunch(radiusMeters: number): PunchSide {
  return {
    at: null,
    method: null,
    latitude: null,
    longitude: null,
    gps: '—',
    distanceMeters: null,
    distanceLabel: '—',
    radiusMeters,
    siteStatus: '—',
    mapUrl: null,
    displayDeviceId: '—',
    deviceType: '—',
    ip: '—',
    flagged: false,
  };
}

export function buildPunchSide(input: {
  at: Date | string | null | undefined;
  method: string | null | undefined;
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  ip: string | null | undefined;
  device: DeviceRow | null;
  project: { latitude: number; longitude: number; radiusMeters: number };
}): PunchSide {
  const radius = input.project.radiusMeters;
  if (!input.at) return emptyPunch(radius);

  const lat = input.latitude ?? null;
  const lng = input.longitude ?? null;
  let distanceMeters: number | null = null;
  let siteStatus = '—';
  if (lat != null && lng != null) {
    const geo = isInsideRadius(lat, lng, input.project.latitude, input.project.longitude, radius);
    distanceMeters = geo.distance;
    siteStatus = geo.inside ? 'Inside site' : 'Outside site';
  }

  return {
    at: input.at instanceof Date ? input.at.toISOString() : String(input.at),
    method: input.method || '—',
    latitude: lat,
    longitude: lng,
    gps: formatGps(lat, lng),
    distanceMeters,
    distanceLabel: distanceMeters == null ? '—' : `${distanceMeters} m`,
    radiusMeters: radius,
    siteStatus,
    mapUrl: punchMapUrl(lat, lng),
    displayDeviceId: input.device ? displayDeviceId(input.device.deviceFingerprint) : '—',
    deviceType: describeUserAgent(input.device?.userAgent),
    ip: dash(input.ip),
    flagged: !!input.device?.flagged,
  };
}

export function securityDisplayFrom(input: {
  checkInDevice: (DeviceRow & { employee?: DeviceEmployee | null }) | null;
  checkOutDevice: (DeviceRow & { employee?: DeviceEmployee | null }) | null;
  audits: Array<{ action: string }>;
  attendanceEmployee: DeviceEmployee;
}): { status: string; flags: string[]; labels: string[] } {
  if (!isSecurityRelevantEmployee(input.attendanceEmployee)) {
    return { status: 'Normal', flags: [], labels: ['Normal'] };
  }
  const flags: string[] = [];
  if (input.audits.some((a) => a.action === 'SECURITY_NEW_DEVICE')) flags.push('NEW_DEVICE');
  const multiAudit = input.audits.some((a) => a.action === 'SECURITY_DEVICE_MULTI_ACCOUNT');
  const flaggedDevice = !!(input.checkInDevice?.flagged || input.checkOutDevice?.flagged);
  if (multiAudit || flaggedDevice) flags.push('MULTI_ACCOUNT');

  if (flags.length === 0) return { status: 'Normal', flags: [], labels: ['Normal'] };
  const labels = flags.map((f) =>
    f === 'NEW_DEVICE' ? 'New Device' : 'Device used by multiple accounts'
  );
  return { status: labels.join(' · '), flags, labels };
}

export function buildAttendanceDetails(input: {
  id: string;
  employee: DeviceEmployee & { fullName: string; employeeCode: string };
  project: {
    name: string;
    locationLabel: string | null;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  };
  shift: { name: string; startTime: string; endTime: string };
  checkInAt: Date | string | null;
  checkOutAt: Date | string | null;
  checkInMethod: string | null;
  checkOutMethod: string | null;
  checkInLatitude: number | null;
  checkInLongitude: number | null;
  checkOutLatitude: number | null;
  checkOutLongitude: number | null;
  checkInIp: string | null;
  checkOutIp: string | null;
  checkInDevice: DeviceRow | null;
  checkOutDevice: DeviceRow | null;
  audits: Array<{ action: string }>;
}): AttendanceDetails {
  return {
    id: input.id,
    employeeName: input.employee.fullName,
    employeeCode: input.employee.employeeCode,
    project: input.project.name,
    projectLocation: input.project.locationLabel,
    shiftLabel: shiftDisplayLabel(input.shift).replace('\n', ' · '),
    checkIn: buildPunchSide({
      at: input.checkInAt,
      method: input.checkInMethod,
      latitude: input.checkInLatitude,
      longitude: input.checkInLongitude,
      ip: input.checkInIp,
      device: input.checkInDevice,
      project: input.project,
    }),
    checkOut: buildPunchSide({
      at: input.checkOutAt,
      method: input.checkOutMethod,
      latitude: input.checkOutLatitude,
      longitude: input.checkOutLongitude,
      ip: input.checkOutIp,
      device: input.checkOutDevice,
      project: input.project,
    }),
    security: securityDisplayFrom({
      checkInDevice: input.checkInDevice,
      checkOutDevice: input.checkOutDevice,
      audits: input.audits,
      attendanceEmployee: input.employee,
    }),
  };
}

export function auditActionLabel(action: string): string {
  switch (action) {
    case 'CHECK_IN':
      return 'Check-in';
    case 'CHECK_OUT':
      return 'Check-out';
    case 'SECURITY_NEW_DEVICE':
      return 'New device';
    case 'SECURITY_DEVICE_MULTI_ACCOUNT':
      return 'Device used by multiple accounts';
    case 'MANUAL_CHECK_IN':
      return 'Manual check-in';
    case 'MANUAL_CHECK_OUT':
      return 'Manual check-out';
    case 'SCHEDULE_CREATED':
      return 'Schedule created';
    case 'SCHEDULE_UPDATED':
      return 'Schedule updated';
    case 'SCHEDULE_COPIED':
      return 'Schedule copied';
    case 'SCHEDULE_REPEATED':
      return 'Schedule repeated';
    default:
      return action.replace(/_/g, ' ');
  }
}

export function auditActionTone(action: string): 'ok' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (action === 'SECURITY_DEVICE_MULTI_ACCOUNT') return 'danger';
  if (action === 'SECURITY_NEW_DEVICE') return 'warn';
  if (action === 'CHECK_IN' || action === 'CHECK_OUT') return 'ok';
  return 'neutral';
}
