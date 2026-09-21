import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getBrowserDeviceId, BROWSER_DEVICE_ID_KEY } from './browser-device-id';
import { describeUserAgent, displayDeviceId, formatGps, punchMapUrl } from './device-display';
import {
  decideDeviceSecurity,
  isSecurityRelevantEmployee,
  observePunchDevice,
  recordDeviceWarnings,
  type DeviceDb,
  type DeviceEmployee,
  type DeviceRow,
} from './device-security';
import {
  buildAttendanceDetails,
  buildPunchSide,
  canViewAttendanceDetails,
  securityDisplayFrom,
} from './attendance-details';
import { fingerprintFromRequest } from './security';
import { isInsideRadius } from './geo';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-auth-secret-for-device-security-32';
process.env.QR_SECRET = process.env.QR_SECRET || 'test-qr-secret-for-device-security-32ab';

const realA: DeviceEmployee = {
  id: 'emp-a',
  fullName: 'Abdulaziz Abdullah H AlZahrani',
  employeeCode: '71326',
  isActive: true,
  user: { role: 'EMPLOYEE', isActive: true },
};
const realB: DeviceEmployee = {
  id: 'emp-b',
  fullName: 'Abdullah Mahmoud B AlAnazi',
  employeeCode: '71343',
  isActive: true,
  user: { role: 'EMPLOYEE', isActive: true },
};
const demo: DeviceEmployee = {
  id: 'emp-demo',
  fullName: 'Demo Employee',
  employeeCode: 'EMP-0147',
  isActive: false,
  user: { role: 'EMPLOYEE', isActive: false },
};

function memStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

function createDeviceDb(seed: { devices?: DeviceRow[]; employees?: DeviceEmployee[] }): DeviceDb & {
  devices: DeviceRow[];
} {
  const devices = [...(seed.devices || [])];
  const employees = seed.employees || [];
  let seq = 1;
  return {
    devices,
    device: {
      findFirst: async (args?: { where?: { deviceFingerprint?: string } }) =>
        devices.find((d) => d.deviceFingerprint === args?.where?.deviceFingerprint) ?? null,
      findMany: async (args?: { where?: { employeeId?: string; deviceFingerprint?: { not?: string } } }) =>
        devices.filter((d) => {
          if (args?.where?.employeeId && d.employeeId !== args.where.employeeId) return false;
          if (args?.where?.deviceFingerprint?.not && d.deviceFingerprint === args.where.deviceFingerprint.not) {
            return false;
          }
          return true;
        }),
      create: async (args?: { data?: Partial<DeviceRow> }) => {
        const row: DeviceRow = {
          id: `dev-${seq++}`,
          employeeId: args?.data?.employeeId ?? null,
          deviceFingerprint: String(args?.data?.deviceFingerprint || ''),
          userAgent: args?.data?.userAgent ?? null,
          flagged: false,
        };
        devices.push(row);
        return row;
      },
      update: async (args?: { where?: { id?: string }; data?: Partial<DeviceRow> }) => {
        const found = devices.find((d) => d.id === args?.where?.id);
        if (!found) throw new Error('missing device');
        Object.assign(found, args?.data || {});
        return found;
      },
    },
    employee: {
      findUnique: async (args?: { where?: { id?: string } }) =>
        employees.find((e) => e.id === args?.where?.id) ?? null,
    },
  };
}

const project = {
  name: 'Riyadh Night Site',
  locationLabel: 'Riyadh',
  latitude: 24.7136,
  longitude: 46.6753,
  radiusMeters: 150,
};

const shift = { name: 'Night Shift 1', startTime: '15:30', endTime: '03:30' };

describe('stable browser device id', () => {
  it('creates once and reuses the same id for check-in and check-out', () => {
    const store = memStore();
    const first = getBrowserDeviceId(store);
    const second = getBrowserDeviceId(store);
    assert.ok(first && first.length >= 8);
    assert.equal(first, second);
    assert.equal(store.data[BROWSER_DEVICE_ID_KEY], first);
    const inFp = fingerprintFromRequest('Mozilla/5.0 iPhone', first);
    const outFp = fingerprintFromRequest('Mozilla/5.0 iPhone', second);
    assert.equal(inFp, outFp);
  });

  it('falls back without crashing when storage is unavailable', () => {
    assert.equal(getBrowserDeviceId(null), undefined);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    assert.equal(getBrowserDeviceId(throwing), undefined);
  });
});

describe('device display', () => {
  it('shows a short DEV- id and never the full fingerprint', () => {
    const fp = fingerprintFromRequest('Mozilla/5.0', 'abc-uuid');
    const shown = displayDeviceId(fp);
    assert.match(shown, /^DEV-[A-F0-9]{8}$/);
    assert.equal(shown.includes(fp), false);
  });

  it('maps user-agent to OS · browser', () => {
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      ),
      'iPhone · Safari'
    );
    assert.equal(
      describeUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'),
      'Android · Chrome'
    );
    assert.equal(
      describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'),
      'Windows · Chrome'
    );
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      ),
      'Mac · Safari'
    );
  });
});

describe('device security warnings', () => {
  it('first device for an employee is not a new-device warning', async () => {
    const db = createDeviceDb({ employees: [realA] });
    const observed = await observePunchDevice(db, {
      employee: realA,
      fingerprint: 'fp-phone-a',
      userAgent: 'Mozilla/5.0 (iPhone) Safari',
    });
    assert.deepEqual(observed.warnings, []);
    assert.equal(db.devices.length, 1);
    assert.equal(db.devices[0].employeeId, realA.id);
    assert.equal(db.devices[0].flagged, false);
  });

  it('second device for the same employee records SECURITY_NEW_DEVICE and still succeeds', async () => {
    const db = createDeviceDb({
      employees: [realA],
      devices: [
        {
          id: 'dev-old',
          employeeId: realA.id,
          deviceFingerprint: 'fp-old',
          userAgent: 'old',
          flagged: false,
        },
      ],
    });
    const audits: string[] = [];
    const observed = await observePunchDevice(db, {
      employee: realA,
      fingerprint: 'fp-new',
      userAgent: 'Mozilla/5.0 (iPhone) Safari',
    });
    assert.deepEqual(observed.warnings, ['NEW_DEVICE']);
    await recordDeviceWarnings(async (row) => {
      audits.push(row.action);
    }, {
      actorId: 'user-a',
      attendanceId: 'att-1',
      ip: '10.0.0.8',
      userAgent: 'Mozilla/5.0 (iPhone) Safari',
      observed,
      employee: realA,
      operation: 'check-in',
    });
    assert.deepEqual(audits, ['SECURITY_NEW_DEVICE']);
    assert.equal(db.devices.length, 2);
    assert.equal(db.devices[1].flagged, false);
  });

  it('same device on a second employee flags the device and records MULTI_ACCOUNT without rebinding', async () => {
    const db = createDeviceDb({
      employees: [realA, realB],
      devices: [
        {
          id: 'dev-shared',
          employeeId: realA.id,
          deviceFingerprint: 'fp-shared',
          userAgent: 'Mozilla/5.0',
          flagged: false,
        },
      ],
    });
    const observed = await observePunchDevice(db, {
      employee: realB,
      fingerprint: 'fp-shared',
      userAgent: 'Mozilla/5.0',
    });
    assert.ok(observed.warnings.includes('MULTI_ACCOUNT'));
    assert.equal(observed.previousEmployeeCode, '71326');
    assert.equal(db.devices[0].flagged, true);
    assert.equal(db.devices[0].employeeId, realA.id);
  });

  it('check-out uses the same device security logic', async () => {
    const db = createDeviceDb({
      employees: [realA, realB],
      devices: [
        {
          id: 'dev-a',
          employeeId: realA.id,
          deviceFingerprint: 'fp-a',
          userAgent: 'ua',
          flagged: false,
        },
        {
          id: 'dev-b1',
          employeeId: realB.id,
          deviceFingerprint: 'fp-b-old',
          userAgent: 'ua',
          flagged: false,
        },
      ],
    });
    const observed = await observePunchDevice(db, {
      employee: realB,
      fingerprint: 'fp-a',
      userAgent: 'ua',
    });
    assert.ok(observed.warnings.includes('MULTI_ACCOUNT'));
    assert.ok(observed.warnings.includes('NEW_DEVICE'));
    const audits: Array<{ action: string; entityId?: string }> = [];
    await recordDeviceWarnings(async (row) => {
      audits.push({ action: row.action, entityId: row.entityId });
    }, {
      actorId: 'user-b',
      attendanceId: 'att-out',
      ip: '10.1.1.1',
      userAgent: 'ua',
      observed,
      employee: realB,
      operation: 'check-out',
    });
    assert.equal(audits.some((a) => a.action === 'SECURITY_DEVICE_MULTI_ACCOUNT' && a.entityId === 'att-out'), true);
    assert.equal(audits.some((a) => a.action === 'SECURITY_NEW_DEVICE'), true);
    assert.equal(db.devices.find((d) => d.id === 'dev-a')?.employeeId, realA.id);
  });

  it('does not treat a demo/inactive previous owner as multi-account', async () => {
    const db = createDeviceDb({
      employees: [demo, realA],
      devices: [
        {
          id: 'dev-demo',
          employeeId: demo.id,
          deviceFingerprint: 'fp-demo',
          userAgent: 'ua',
          flagged: false,
        },
      ],
    });
    const observed = await observePunchDevice(db, {
      employee: realA,
      fingerprint: 'fp-demo',
      userAgent: 'ua',
    });
    assert.equal(observed.warnings.includes('MULTI_ACCOUNT'), false);
    assert.equal(db.devices[0].employeeId, demo.id);
  });

  it('decideDeviceSecurity never reassigns a device', () => {
    const decision = decideDeviceSecurity({
      employee: realB,
      existingDevice: {
        id: 'd1',
        employeeId: realA.id,
        deviceFingerprint: 'fp',
        userAgent: 'ua',
        flagged: false,
      },
      previousDevicesForEmployee: [],
      previousOwner: realA,
    });
    assert.equal(decision.reassign, false);
    assert.equal(decision.warnMultiAccount, true);
    assert.equal(decision.warnNewDevice, false);
  });
});

describe('attendance details GPS and permissions', () => {
  it('calculates distance from stored punch GPS and project coordinates', () => {
    const same = isInsideRadius(24.7136, 46.6753, 24.7136, 46.6753, 150);
    assert.equal(same.distance, 0);
    assert.equal(same.inside, true);
    const punch = buildPunchSide({
      at: new Date('2026-09-21T12:40:00.000Z'),
      method: 'QR',
      latitude: 24.7136,
      longitude: 46.6753,
      ip: '10.0.0.8',
      device: {
        id: 'd1',
        employeeId: realA.id,
        deviceFingerprint: 'abcdef1234567890',
        userAgent: 'Mozilla/5.0 (iPhone) Version/17.0 Safari/604.1',
        flagged: false,
      },
      project,
    });
    assert.equal(punch.distanceMeters, 0);
    assert.equal(punch.distanceLabel, '0 m');
    assert.equal(punch.siteStatus, 'Inside site');
    assert.equal(punch.gps, '24.713600, 46.675300');
    assert.equal(punch.displayDeviceId, 'DEV-ABCDEF12');
    assert.equal(punch.deviceType, 'iPhone · Safari');
    assert.ok(punch.mapUrl?.includes('24.7136'));
  });

  it('handles missing checkout values safely', () => {
    const details = buildAttendanceDetails({
      id: 'att-1',
      employee: realA,
      project,
      shift,
      checkInAt: new Date('2026-09-21T12:40:00.000Z'),
      checkOutAt: null,
      checkInMethod: 'QR',
      checkOutMethod: null,
      checkInLatitude: 24.7136,
      checkInLongitude: 46.6753,
      checkOutLatitude: null,
      checkOutLongitude: null,
      checkInIp: '10.0.0.8',
      checkOutIp: null,
      checkInDevice: {
        id: 'd1',
        employeeId: realA.id,
        deviceFingerprint: 'aa11bb22',
        userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0',
        flagged: false,
      },
      checkOutDevice: null,
      audits: [],
    });
    assert.equal(details.checkOut.at, null);
    assert.equal(details.checkOut.gps, '—');
    assert.equal(details.checkOut.distanceLabel, '—');
    assert.equal(details.checkOut.displayDeviceId, '—');
    assert.equal(details.checkOut.ip, '—');
    assert.equal(details.checkOut.siteStatus, '—');
    assert.equal(details.checkOut.mapUrl, null);
    assert.equal(details.security.status, 'Normal');
    assert.equal(formatGps(null, null), '—');
    assert.equal(punchMapUrl(null, null), null);
  });

  it('details API permission checks', () => {
    assert.equal(canViewAttendanceDetails('ADMIN'), true);
    assert.equal(canViewAttendanceDetails('HR'), true);
    assert.equal(canViewAttendanceDetails('SUPERVISOR'), true);
    assert.equal(canViewAttendanceDetails('SECURITY'), true);
    assert.equal(canViewAttendanceDetails('EMPLOYEE'), false);
    assert.equal(canViewAttendanceDetails(null), false);
  });

  it('returns check-in and check-out metadata', () => {
    const details = buildAttendanceDetails({
      id: 'att-2',
      employee: realA,
      project,
      shift,
      checkInAt: new Date('2026-09-21T12:40:00.000Z'),
      checkOutAt: new Date('2026-09-22T00:10:00.000Z'),
      checkInMethod: 'QR',
      checkOutMethod: 'QR',
      checkInLatitude: 24.7136,
      checkInLongitude: 46.6753,
      checkOutLatitude: 24.7137,
      checkOutLongitude: 46.6753,
      checkInIp: '10.0.0.8',
      checkOutIp: '10.0.0.9',
      checkInDevice: {
        id: 'd1',
        employeeId: realA.id,
        deviceFingerprint: 'aa11bb22cc',
        userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1',
        flagged: false,
      },
      checkOutDevice: {
        id: 'd1',
        employeeId: realA.id,
        deviceFingerprint: 'aa11bb22cc',
        userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1',
        flagged: false,
      },
      audits: [{ action: 'SECURITY_NEW_DEVICE' }],
    });
    assert.equal(details.checkIn.method, 'QR');
    assert.equal(details.checkOut.method, 'QR');
    assert.ok(details.checkOut.distanceMeters != null);
    assert.ok(details.security.labels.includes('New Device'));
    assert.match(details.shiftLabel, /Shift 1/);
  });

  it('inactive/demo employees do not affect security display', () => {
    assert.equal(isSecurityRelevantEmployee(demo), false);
    const shown = securityDisplayFrom({
      checkInDevice: {
        id: 'd-demo',
        employeeId: demo.id,
        deviceFingerprint: 'ff',
        userAgent: 'ua',
        flagged: true,
      },
      checkOutDevice: null,
      audits: [{ action: 'SECURITY_NEW_DEVICE' }, { action: 'SECURITY_DEVICE_MULTI_ACCOUNT' }],
      attendanceEmployee: demo,
    });
    assert.equal(shown.status, 'Normal');
    assert.deepEqual(shown.labels, ['Normal']);
  });
});
