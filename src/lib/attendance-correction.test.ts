import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateAttendance, scheduledWindow } from './attendance-calc';
import {
  applyAttendanceCorrection,
  correctionCalc,
  planAttendanceCorrection,
  parseAppDateTime,
} from './attendance-correction';
import { catalogFromShifts } from './shift-catalog';
import { planDayException } from './day-exception-service';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

const shift1 = {
  id: 's1',
  name: 'Night Shift 1',
  startTime: '15:30',
  endTime: '03:30',
  crossesMidnight: true,
  gracePeriodMinutes: 5,
  isActive: true,
  minWorkMinutes: null,
  overtimeRequiresApproval: false,
  checkinWindowBeforeMinutes: 30,
  checkoutWindowAfterMinutes: 180,
  createdAt: new Date(),
};
const catalog = catalogFromShifts([shift1 as any]);

describe('attendance correction', () => {
  it('requires a reason and refuses silent overwrite of real attendance', () => {
    assert.equal(
      planAttendanceCorrection({
        employeeId: 'e1',
        workDate: '2026-09-26',
        reason: '',
        existingAssignment: { id: 'a1', status: 'SCHEDULED', shiftId: 's1' },
        existingAttendance: null,
        catalog,
      }).ok,
      false
    );
    const missingOut = planAttendanceCorrection({
      employeeId: 'e1',
      workDate: '2026-09-26',
      reason: 'Punching Issue',
      existingAssignment: { id: 'a1', status: 'SCHEDULED', shiftId: 's1' },
      existingAttendance: { id: 'att1', checkInAt: new Date(), checkOutAt: null },
      catalog,
    });
    assert.equal(missingOut.ok, true);
    if (missingOut.ok) {
      assert.equal(missingOut.mode, 'missing_out');
      assert.equal(missingOut.existingAttendanceId, 'att1');
    }
    const locked = planAttendanceCorrection({
      employeeId: 'e1',
      workDate: '2026-09-26',
      reason: 'Punching Issue',
      existingAssignment: { id: 'a1', status: 'SCHEDULED', shiftId: 's1' },
      existingAttendance: {
        id: 'att1',
        checkInAt: new Date(),
        checkOutAt: new Date(),
      },
      catalog,
    });
    assert.equal(locked.ok, false);
    if (!locked.ok) assert.equal(locked.status, 409);
  });

  it('requires Shift 1 or Shift 2 when no assignment exists', () => {
    const missing = planAttendanceCorrection({
      employeeId: 'e1',
      workDate: '2026-09-26',
      reason: 'Punching Issue',
      existingAssignment: null,
      existingAttendance: null,
      catalog,
    });
    assert.equal(missing.ok, false);
    const ready = planAttendanceCorrection({
      employeeId: 'e1',
      workDate: '2026-09-26',
      choice: 'SHIFT_1',
      reason: 'Punching Issue',
      existingAssignment: null,
      existingAttendance: null,
      catalog,
    });
    assert.equal(ready.ok, true);
    if (ready.ok) {
      assert.equal(ready.needsAssignment, true);
      assert.equal(ready.choice, 'SHIFT_1');
    }
  });

  it('uses existing calculateAttendance() for the chosen shift/date', () => {
    const checkInAt = parseAppDateTime('2026-09-26', '2026-09-26T15:40')!;
    const checkOutAt = parseAppDateTime('2026-09-27', '2026-09-27T03:30')!;
    const built = correctionCalc({
      workDate: '2026-09-26',
      startTime: '15:30',
      endTime: '03:30',
      crossesMidnight: true,
      gracePeriodMinutes: 5,
      checkInAt,
      checkOutAt,
    });
    const window = scheduledWindow('2026-09-26', '15:30', '03:30', true);
    const expected = calculateAttendance({
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      checkInAt,
      checkOutAt,
      gracePeriodMinutes: 5,
      manualCheckIn: true,
      manualCheckOut: true,
    });
    assert.deepEqual(built.calc, expected);
    assert.equal(built.window.scheduledStart.toISOString(), window.scheduledStart.toISOString());
  });

  it('creates historical attendance with reason and writes audit', async () => {
    const audits: any[] = [];
    const created: any[] = [];
    const adjustments: any[] = [];
    const checkInAt = parseAppDateTime('2026-09-26', '2026-09-26T15:40')!;
    const checkOutAt = parseAppDateTime('2026-09-27', '2026-09-27T03:45')!;
    const result = await applyAttendanceCorrection({
      db: {
        employee: {
          findUnique: async () => ({ id: 'e1', defaultProjectId: 'p1' }),
        },
        project: { findFirst: async () => ({ id: 'p1' }) },
        employeeShiftAssignment: {
          findFirst: async () => null,
          create: async (args: any) => ({ id: 'a1', shiftId: args.data.shiftId, ...args.data }),
          update: async () => null,
        },
        attendanceRecord: {
          findFirst: async () => null,
          create: async (args: any) => {
            created.push(args.data);
            return { id: 'att1', ...args.data };
          },
        },
        attendanceAdjustment: {
          create: async (args: any) => {
            adjustments.push(args.data);
            return args.data;
          },
        },
      },
      catalog,
      actorId: 'admin1',
      employeeId: 'e1',
      workDate: '2026-09-26',
      choice: 'SHIFT_1',
      checkInAt,
      checkOutAt,
      reason: 'Punching Issue',
      writeAudit: async (row) => {
        audits.push(row);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].shiftId, 's1');
    assert.equal(created[0].manualOverride, true);
    assert.match(created[0].flags, /PUNCHING_ISSUE/);
    assert.equal(adjustments[0].reason, 'Punching Issue');
    assert.equal(audits[0].action, 'ATTENDANCE_CORRECTED');
    assert.equal(audits[0].employeeId, 'e1');
    assert.equal(audits[0].newValue.workDate, '2026-09-26');
    assert.equal(audits[0].newValue.reason, 'Punching Issue');
    if (result.ok) {
      const window = scheduledWindow('2026-09-26', '15:30', '03:30', true);
      assert.deepEqual(
        result.calc,
        calculateAttendance({
          scheduledStart: window.scheduledStart,
          scheduledEnd: window.scheduledEnd,
          checkInAt,
          checkOutAt,
          gracePeriodMinutes: 5,
          manualCheckIn: true,
          manualCheckOut: true,
        })
      );
    }
  });

  it('does not overwrite existing real attendance when applying', async () => {
    const result = await applyAttendanceCorrection({
      db: {
        employee: { findUnique: async () => ({ id: 'e1', defaultProjectId: 'p1' }) },
        project: { findFirst: async () => ({ id: 'p1' }) },
        employeeShiftAssignment: {
          findFirst: async () => ({
            id: 'a1',
            status: 'SCHEDULED',
            shiftId: 's1',
            projectId: 'p1',
            shift: shift1,
            attendance: [
              {
                id: 'att1',
                checkInAt: new Date('2026-09-26T12:40:00.000Z'),
                checkOutAt: new Date('2026-09-22T00:30:00.000Z'),
              },
            ],
          }),
          create: async () => {
            throw new Error('should not create assignment');
          },
          update: async () => {
            throw new Error('should not update assignment');
          },
        },
        attendanceRecord: {
          findFirst: async () => null,
          create: async () => {
            throw new Error('should not create attendance');
          },
        },
        attendanceAdjustment: {
          create: async () => {
            throw new Error('should not adjust');
          },
        },
      },
      catalog,
      actorId: 'admin1',
      employeeId: 'e1',
      workDate: '2026-09-26',
      reason: 'Punching Issue',
      checkInAt: new Date(),
      checkOutAt: null,
      writeAudit: async () => {
        throw new Error('should not audit overwrite');
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
  });
});

describe('missing checkout correction', () => {
  const originalCheckIn = parseAppDateTime('2026-09-26', '2026-09-26T15:40')!;
  const actualOut = parseAppDateTime('2026-09-27', '2026-09-27T03:35')!;
  const window = scheduledWindow('2026-09-26', '15:30', '03:30', true);

  it('preserves original check-in and updates checkout + calculations + audit', async () => {
    const updates: any[] = [];
    const adjustments: any[] = [];
    const audits: any[] = [];
    const existing = {
      id: 'att-open',
      employeeId: 'e1',
      checkInAt: originalCheckIn,
      checkOutAt: null,
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      checkInMethod: 'QR',
      checkInLatitude: 26.3,
      checkInLongitude: 50.1,
      checkInDeviceId: 'dev-1',
      workedMinutes: null,
      overtimeMinutes: 0,
      earlyLeaveMinutes: 0,
      statusPrimary: 'WORKING',
      shift: shift1,
    };
    const result = await applyAttendanceCorrection({
      db: {
        employee: { findUnique: async () => ({ id: 'e1', defaultProjectId: 'p1' }) },
        project: { findFirst: async () => ({ id: 'p1' }) },
        employeeShiftAssignment: {
          findFirst: async () => ({
            id: 'a1',
            status: 'SCHEDULED',
            shiftId: 's1',
            projectId: 'p1',
            shift: shift1,
            attendance: [existing],
          }),
          create: async () => {
            throw new Error('should not create assignment');
          },
          update: async () => {
            throw new Error('should not update assignment');
          },
        },
        attendanceRecord: {
          findFirst: async () => existing,
          findUnique: async () => existing,
          create: async () => {
            throw new Error('should not create attendance');
          },
          update: async (args: any) => {
            updates.push(args);
            return { ...existing, ...args.data };
          },
        },
        attendanceAdjustment: {
          create: async (args: any) => {
            adjustments.push(args.data);
            return args.data;
          },
        },
      },
      catalog,
      actorId: 'admin1',
      employeeId: 'e1',
      workDate: '2026-09-26',
      attendanceId: 'att-open',
      checkInAt: parseAppDateTime('2026-09-26', '2026-09-26T19:00'),
      checkOutAt: actualOut,
      reason: 'Forgot checkout',
      writeAudit: async (row) => {
        audits.push(row);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].where.id, 'att-open');
    assert.equal(updates[0].data.checkOutAt.toISOString(), actualOut.toISOString());
    assert.equal(updates[0].data.checkOutMethod, 'MANUAL');
    assert.equal(updates[0].data.manualOverride, true);
    assert.equal(updates[0].data.checkInAt, undefined);
    assert.equal(audits[0].action, 'ATTENDANCE_CORRECTED');
    assert.equal(audits[0].oldValue.checkInAt, originalCheckIn.toISOString());
    assert.equal(audits[0].newValue.checkInAt, originalCheckIn.toISOString());
    assert.equal(audits[0].newValue.checkOutAt, actualOut.toISOString());
    assert.equal(audits[0].newValue.reason, 'Forgot checkout');
    assert.equal(adjustments[0].reason, 'Forgot checkout');
    if (result.ok) {
      assert.deepEqual(
        result.calc,
        calculateAttendance({
          scheduledStart: window.scheduledStart,
          scheduledEnd: window.scheduledEnd,
          checkInAt: originalCheckIn,
          checkOutAt: actualOut,
          gracePeriodMinutes: 5,
          manualCheckIn: false,
          manualCheckOut: true,
        })
      );
    }
  });

  it('cannot overwrite a record that already has checkout', async () => {
    const existing = {
      id: 'att-done',
      employeeId: 'e1',
      checkInAt: originalCheckIn,
      checkOutAt: actualOut,
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
    };
    const result = await applyAttendanceCorrection({
      db: {
        employee: { findUnique: async () => ({ id: 'e1', defaultProjectId: 'p1' }) },
        project: { findFirst: async () => ({ id: 'p1' }) },
        employeeShiftAssignment: {
          findFirst: async () => ({
            id: 'a1',
            status: 'SCHEDULED',
            shiftId: 's1',
            projectId: 'p1',
            shift: shift1,
            attendance: [existing],
          }),
          create: async () => {
            throw new Error('should not create assignment');
          },
          update: async () => {
            throw new Error('should not update assignment');
          },
        },
        attendanceRecord: {
          findFirst: async () => existing,
          findUnique: async () => existing,
          create: async () => {
            throw new Error('should not create');
          },
          update: async () => {
            throw new Error('should not update completed attendance');
          },
        },
        attendanceAdjustment: {
          create: async () => {
            throw new Error('should not adjust');
          },
        },
      },
      catalog,
      actorId: 'admin1',
      employeeId: 'e1',
      workDate: '2026-09-26',
      attendanceId: 'att-done',
      checkInAt: originalCheckIn,
      checkOutAt: parseAppDateTime('2026-09-27', '2026-09-27T04:00'),
      reason: 'Try overwrite',
      writeAudit: async () => {
        throw new Error('should not audit overwrite');
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
  });
});

describe('day exception planning', () => {
  it('company holiday and half-day validation', () => {
    const holiday = planDayException(
      { workDate: '2026-09-26', scope: 'HOLIDAY', type: 'HOLIDAY', reason: 'National Day' },
      null
    );
    assert.equal(holiday.ok, true);
    if (holiday.ok) {
      assert.equal(holiday.planned.employeeId, null);
      assert.equal(holiday.planned.auditAction, 'HOLIDAY_CREATED');
    }
    const half = planDayException(
      { workDate: '2026-09-26', scope: 'EMPLOYEE', type: 'HALF_DAY', employeeId: 'e1' },
      null
    );
    assert.equal(half.ok, false);
    const absentWithPunch = planDayException(
      { workDate: '2026-09-26', scope: 'EMPLOYEE', type: 'ABSENT', employeeId: 'e1' },
      null,
      { hasCheckIn: true }
    );
    assert.equal(absentWithPunch.ok, false);
    if (!absentWithPunch.ok) assert.equal(absentWithPunch.status, 409);
    const halfOk = planDayException(
      {
        workDate: '2026-09-26',
        scope: 'EMPLOYEE',
        type: 'HALF_DAY',
        employeeId: 'e1',
        expectedWorkMinutes: 240,
      },
      null
    );
    assert.equal(halfOk.ok, true);
  });

  it('rejects full-day leave and half-day after a real punch, but allows Holiday', () => {
    for (const type of [
      'SICK_LEAVE',
      'VACATION',
      'UMRA_LEAVE',
      'EMERGENCY_VACATION',
      'RELEASED',
      'NEW',
    ] as const) {
      const blocked = planDayException(
        { workDate: '2026-09-26', scope: 'EMPLOYEE', type, employeeId: 'e1' },
        null,
        { hasCheckIn: true }
      );
      assert.equal(blocked.ok, false, type);
      if (!blocked.ok) assert.equal(blocked.status, 409);
    }
    const halfAfterPunch = planDayException(
      {
        workDate: '2026-09-26',
        scope: 'EMPLOYEE',
        type: 'HALF_DAY',
        employeeId: 'e1',
        expectedWorkMinutes: 240,
      },
      null,
      { hasCheckIn: true }
    );
    assert.equal(halfAfterPunch.ok, false);
    if (!halfAfterPunch.ok) {
      assert.equal(halfAfterPunch.status, 409);
      assert.match(halfAfterPunch.error, /attendance correction/i);
    }
    const holidayAfterPunch = planDayException(
      { workDate: '2026-09-26', scope: 'HOLIDAY', type: 'HOLIDAY', reason: 'National Day' },
      null,
      { hasCheckIn: true }
    );
    assert.equal(holidayAfterPunch.ok, true);
    const sickBeforePunch = planDayException(
      { workDate: '2026-09-26', scope: 'EMPLOYEE', type: 'SICK_LEAVE', employeeId: 'e1' },
      null,
      { hasCheckIn: false }
    );
    assert.equal(sickBeforePunch.ok, true);
  });
});
