import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import {
  calculateAttendance,
  requiredWorkMinutesForAttendance,
  scheduledWindow,
  validRequiredWorkMinutes,
} from './attendance-calc';
import { resolveAttendanceDayPolicy } from './attendance-policy';
import { assignmentDisplayWindow, resolveAttendanceDisplay } from './attendance-state';
import { filterBoardRows } from './dashboard-board';
import { classifyOpenAttendance } from './open-attendance';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

function riyadh(isoLocal: string): Date {
  return DateTime.fromISO(isoLocal, { zone: 'Asia/Riyadh' }).toJSDate();
}

const shift1 = scheduledWindow('2026-09-26', '15:30', '03:30', true);
const shift2 = scheduledWindow('2026-09-26', '19:00', '07:00', true);

function completed(input: {
  window: { scheduledStart: Date; scheduledEnd: Date };
  inAt: string;
  outAt: string;
  requiredWorkMinutes?: number;
  holidayWork?: boolean;
  halfDay?: boolean;
}) {
  return calculateAttendance({
    scheduledStart: input.window.scheduledStart,
    scheduledEnd: input.window.scheduledEnd,
    checkInAt: riyadh(input.inAt),
    checkOutAt: riyadh(input.outAt),
    gracePeriodMinutes: 5,
    requiredWorkMinutes: input.requiredWorkMinutes,
    holidayWork: input.holidayWork,
    halfDay: input.halfDay,
  });
}

describe('8-hour required work fallback', () => {
  it('null/invalid minWorkMinutes safely means 480', () => {
    assert.equal(validRequiredWorkMinutes(null), 480);
    assert.equal(validRequiredWorkMinutes(undefined), 480);
    assert.equal(validRequiredWorkMinutes(0), 480);
    assert.equal(validRequiredWorkMinutes(-30), 480);
    assert.equal(validRequiredWorkMinutes(2000), 480);
    assert.equal(validRequiredWorkMinutes(480), 480);
  });

  it('Half Day uses expectedWorkMinutes, else approved window duration', () => {
    const halfWindow = scheduledWindow('2026-09-26', '15:30', '19:30', false);
    assert.equal(
      requiredWorkMinutesForAttendance({
        shiftMinWorkMinutes: null,
        exceptionType: 'HALF_DAY',
        exceptionExpectedWorkMinutes: 180,
        scheduledStart: halfWindow.scheduledStart,
        scheduledEnd: halfWindow.scheduledEnd,
      }),
      180
    );
    assert.equal(
      requiredWorkMinutesForAttendance({
        shiftMinWorkMinutes: null,
        exceptionType: 'HALF_DAY',
        exceptionExpectedWorkMinutes: null,
        scheduledStart: halfWindow.scheduledStart,
        scheduledEnd: halfWindow.scheduledEnd,
      }),
      240
    );
    const policy = resolveAttendanceDayPolicy({
      workDate: '2026-09-26',
      employeeId: 'e1',
      shiftMinWorkMinutes: null,
      scheduledStart: halfWindow.scheduledStart,
      scheduledEnd: halfWindow.scheduledEnd,
      exceptions: [
        {
          workDate: '2026-09-26',
          employeeId: 'e1',
          type: 'HALF_DAY',
          expectedStartTime: '15:30',
          expectedEndTime: '19:30',
        },
      ],
    });
    assert.equal(policy.requiredWorkMinutes, 240);
    assert.equal(policy.halfDay, true);
    const storedFullShift = scheduledWindow('2026-09-26', '15:30', '03:30', true);
    const fromApprovedWindow = resolveAttendanceDayPolicy({
      workDate: '2026-09-26',
      employeeId: 'e1',
      shiftMinWorkMinutes: null,
      scheduledStart: storedFullShift.scheduledStart,
      scheduledEnd: storedFullShift.scheduledEnd,
      exceptions: [
        {
          workDate: '2026-09-26',
          employeeId: 'e1',
          type: 'HALF_DAY',
          expectedStartTime: '15:30',
          expectedEndTime: '19:30',
        },
      ],
    });
    assert.equal(fromApprovedWindow.requiredWorkMinutes, 240);
  });
});

describe('Shift 1 15:30-03:30 required 480', () => {
  it('A) 15:30-23:30 worked 480 OT 0 ON_TIME', () => {
    const result = completed({ window: shift1, inAt: '2026-09-26T15:30:00', outAt: '2026-09-26T23:30:00' });
    assert.equal(result.workedMinutes, 480);
    assert.equal(result.lateMinutes, 0);
    assert.equal(result.earlyLeaveMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.statusPrimary, 'ON_TIME');
    assert.deepEqual(
      result.flags.filter((f) => f === 'PRESENT' || f === 'ON_TIME' || f === 'OVERTIME' || f === 'EARLY_DEPARTURE'),
      ['PRESENT', 'ON_TIME']
    );
  });

  it('B) 15:30-00:30 worked 540 OT 60 ON_TIME + OVERTIME', () => {
    const result = completed({ window: shift1, inAt: '2026-09-26T15:30:00', outAt: '2026-09-27T00:30:00' });
    assert.equal(result.workedMinutes, 540);
    assert.equal(result.lateMinutes, 0);
    assert.equal(result.earlyLeaveMinutes, 0);
    assert.equal(result.overtimeMinutes, 60);
    assert.equal(result.statusPrimary, 'ON_TIME');
    assert.equal(result.flags.includes('OVERTIME'), true);
    assert.notEqual(result.statusPrimary, 'OVERTIME');
  });

  it('C) 15:36-23:36 worked 480 late 6 LATE', () => {
    const result = completed({ window: shift1, inAt: '2026-09-26T15:36:00', outAt: '2026-09-26T23:36:00' });
    assert.equal(result.workedMinutes, 480);
    assert.equal(result.lateMinutes, 6);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.statusPrimary, 'LATE');
  });

  it('D) 15:36-00:36 worked 540 late 6 OT 60 LATE + OVERTIME', () => {
    const result = completed({ window: shift1, inAt: '2026-09-26T15:36:00', outAt: '2026-09-27T00:36:00' });
    assert.equal(result.workedMinutes, 540);
    assert.equal(result.lateMinutes, 6);
    assert.equal(result.overtimeMinutes, 60);
    assert.equal(result.statusPrimary, 'LATE');
    assert.equal(result.flags.includes('LATE'), true);
    assert.equal(result.flags.includes('OVERTIME'), true);
    assert.notEqual(result.statusPrimary, 'OVERTIME');
  });

  it('E) 15:30-22:30 worked 420 short 60 EARLY_DEPARTURE + ON_TIME', () => {
    const result = completed({ window: shift1, inAt: '2026-09-26T15:30:00', outAt: '2026-09-26T22:30:00' });
    assert.equal(result.workedMinutes, 420);
    assert.equal(result.earlyLeaveMinutes, 60);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.statusPrimary, 'EARLY_DEPARTURE');
    assert.equal(result.flags.includes('ON_TIME'), true);
    assert.equal(result.flags.includes('EARLY_DEPARTURE'), true);
  });
});

describe('Shift 2 19:00-07:00 required 480', () => {
  it('F) 19:00-03:00 worked 480 OT 0 ON_TIME', () => {
    const result = completed({ window: shift2, inAt: '2026-09-26T19:00:00', outAt: '2026-09-27T03:00:00' });
    assert.equal(result.workedMinutes, 480);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.statusPrimary, 'ON_TIME');
  });

  it('G) 19:00-07:00 worked 720 OT 240 ON_TIME + OVERTIME', () => {
    const result = completed({ window: shift2, inAt: '2026-09-26T19:00:00', outAt: '2026-09-27T07:00:00' });
    assert.equal(result.workedMinutes, 720);
    assert.equal(result.overtimeMinutes, 240);
    assert.equal(result.statusPrimary, 'ON_TIME');
    assert.equal(result.flags.includes('OVERTIME'), true);
    assert.notEqual(result.statusPrimary, 'OVERTIME');
  });
});

describe('grace remains scheduledStart-based', () => {
  it('H) Shift1 15:35 late 0 and 15:36 late 6', () => {
    const onGrace = calculateAttendance({
      ...shift1,
      checkInAt: riyadh('2026-09-26T15:35:00'),
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    const late = calculateAttendance({
      ...shift1,
      checkInAt: riyadh('2026-09-26T15:36:00'),
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    assert.equal(onGrace.lateMinutes, 0);
    assert.equal(late.lateMinutes, 6);
  });

  it('I) Shift2 19:05 late 0 and 19:06 late 6', () => {
    const onGrace = calculateAttendance({
      ...shift2,
      checkInAt: riyadh('2026-09-26T19:05:00'),
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    const late = calculateAttendance({
      ...shift2,
      checkInAt: riyadh('2026-09-26T19:06:00'),
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    assert.equal(onGrace.lateMinutes, 0);
    assert.equal(late.lateMinutes, 6);
  });
});

describe('open and missing checkout', () => {
  it('J) open punch has no final worked/OT', () => {
    const result = calculateAttendance({
      ...shift1,
      checkInAt: riyadh('2026-09-26T15:30:00'),
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    assert.equal(result.workedMinutes, null);
    assert.equal(result.overtimeMinutes, null);
    assert.equal(result.earlyLeaveMinutes, null);
    assert.equal(result.flags.includes('WORKING'), true);
  });

  it('K) stale open is MISSING_CHECKOUT with worked/OT dashed', () => {
    const punch = {
      checkInAt: riyadh('2026-09-26T15:30:00'),
      checkOutAt: null as Date | null,
      scheduledEnd: shift1.scheduledEnd,
      checkoutWindowAfterMinutes: 180,
      workedMinutes: null,
      lateMinutes: 0,
      overtimeMinutes: 0,
      earlyLeaveMinutes: 0,
      statusPrimary: 'WORKING',
      flags: '["PRESENT","ON_TIME","WORKING"]',
    };
    assert.equal(classifyOpenAttendance(punch, riyadh('2026-09-27T06:31:00')), 'STALE_MISSING_CHECKOUT');
    const display = resolveAttendanceDisplay({
      now: riyadh('2026-09-27T06:31:00'),
      punch,
      scheduledEnd: shift1.scheduledEnd,
      checkoutWindowAfterMinutes: 180,
    });
    assert.equal(display.status, 'MISSING_CHECKOUT');
    assert.equal(display.workedMinutes, null);
    assert.equal(display.overtimeMinutes, null);
    assert.equal(display.earlyLeaveMinutes, null);
  });
});

describe('real corrected examples', () => {
  it('L) Abdulaziz 2026-10-08 19:00-07:00:20 worked 720 OT 240', () => {
    const window = scheduledWindow('2026-10-08', '19:00', '07:00', true);
    const result = calculateAttendance({
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      checkInAt: riyadh('2026-10-08T19:00:00'),
      checkOutAt: riyadh('2026-10-09T07:00:20'),
      gracePeriodMinutes: 5,
    });
    assert.equal(result.workedMinutes, 720);
    assert.equal(result.overtimeMinutes, 240);
    assert.equal(result.lateMinutes, 0);
    assert.equal(result.statusPrimary, 'ON_TIME');
  });

  it('M) Turki 2026-10-08 15:30-03:34:13 worked 724 OT 244', () => {
    const window = scheduledWindow('2026-10-08', '15:30', '03:30', true);
    const result = calculateAttendance({
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      checkInAt: riyadh('2026-10-08T15:30:00'),
      checkOutAt: riyadh('2026-10-09T03:34:13'),
      gracePeriodMinutes: 5,
    });
    assert.equal(result.workedMinutes, 724);
    assert.equal(result.overtimeMinutes, 244);
    assert.equal(result.lateMinutes, 0);
    assert.equal(result.statusPrimary, 'ON_TIME');
  });
});

describe('status flags and dashboard filter', () => {
  it('OVERTIME never becomes statusPrimary and can coexist with ON_TIME or LATE', () => {
    const onTimeOt = completed({ window: shift1, inAt: '2026-09-26T15:30:00', outAt: '2026-09-27T01:30:00' });
    const lateOt = completed({ window: shift1, inAt: '2026-09-26T15:50:00', outAt: '2026-09-27T00:50:00' });
    assert.equal(onTimeOt.statusPrimary, 'ON_TIME');
    assert.equal(onTimeOt.flags.includes('OVERTIME'), true);
    assert.equal(lateOt.statusPrimary, 'LATE');
    assert.equal(lateOt.flags.includes('LATE'), true);
    assert.equal(lateOt.flags.includes('OVERTIME'), true);
    assert.notEqual(onTimeOt.statusPrimary, 'OVERTIME');
    assert.notEqual(lateOt.statusPrimary, 'OVERTIME');
  });

  it('Holiday Work OT stays all worked minutes, not worked-480', () => {
    const result = completed({
      window: shift1,
      inAt: '2026-09-26T15:30:00',
      outAt: '2026-09-27T03:30:00',
      holidayWork: true,
    });
    assert.equal(result.workedMinutes, 720);
    assert.equal(result.overtimeMinutes, 720);
    assert.equal(result.earlyLeaveMinutes, 0);
    assert.equal(result.flags.includes('HOLIDAY_WORK'), true);
  });

  it('dashboard OVERTIME filter finds ON_TIME and LATE rows with OT', () => {
    const rows = [
      {
        employeeName: 'A',
        employeeCode: '71326',
        statusPrimary: 'ON_TIME',
        checkInAt: 'in',
        checkOutAt: 'out',
        lateMinutes: 0,
        overtimeMinutes: 240,
        earlyLeaveMinutes: 0,
        flags: ['PRESENT', 'ON_TIME', 'OVERTIME'],
      },
      {
        employeeName: 'B',
        employeeCode: '71343',
        statusPrimary: 'LATE',
        checkInAt: 'in',
        checkOutAt: 'out',
        lateMinutes: 20,
        overtimeMinutes: 60,
        earlyLeaveMinutes: 0,
        flags: ['PRESENT', 'LATE', 'OVERTIME'],
      },
      {
        employeeName: 'C',
        employeeCode: '71378',
        statusPrimary: 'ON_TIME',
        checkInAt: 'in',
        checkOutAt: 'out',
        lateMinutes: 0,
        overtimeMinutes: 0,
        earlyLeaveMinutes: 0,
        flags: ['PRESENT', 'ON_TIME'],
      },
    ];
    assert.deepEqual(
      filterBoardRows(rows, { status: 'OVERTIME' }).map((r) => r.employeeCode),
      ['71326', '71343']
    );
  });

  it('historical stored 19:30-07:30 window is preserved while 8h OT uses duration', () => {
    const storedStart = riyadh('2026-09-26T19:30:00');
    const storedEnd = riyadh('2026-09-27T07:30:00');
    const display = assignmentDisplayWindow({
      workDate: '2026-09-26',
      startTime: '19:00',
      endTime: '07:00',
      crossesMidnight: true,
      stored: { scheduledStart: storedStart, scheduledEnd: storedEnd },
    });
    assert.equal(display.scheduledStart.toISOString(), storedStart.toISOString());
    assert.equal(display.scheduledEnd.toISOString(), storedEnd.toISOString());
    const result = calculateAttendance({
      scheduledStart: storedStart,
      scheduledEnd: storedEnd,
      checkInAt: riyadh('2026-09-26T19:30:00'),
      checkOutAt: riyadh('2026-09-27T07:30:00'),
      gracePeriodMinutes: 5,
    });
    assert.equal(result.workedMinutes, 720);
    assert.equal(result.overtimeMinutes, 240);
    assert.equal(result.statusPrimary, 'ON_TIME');
  });
});
