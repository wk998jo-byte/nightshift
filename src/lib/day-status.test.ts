import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import {
  evaluateAssignmentDay,
  halfDayWindow,
  isAutomaticWeekendOff,
  type DayExceptionRecord,
} from './day-status';
import { scheduledWindow } from './attendance-calc';
import { buildTonightBoard, type BoardAssignment } from './dashboard-board';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

const workDate = '2026-09-26'; // Saturday
const friday = '2026-10-02';
const window = scheduledWindow(workDate, '15:30', '03:30', true);
const after = DateTime.fromISO(`${workDate}T18:00:00`, { zone: 'Asia/Riyadh' }).toJSDate();
const before = DateTime.fromISO(`${workDate}T14:00:00`, { zone: 'Asia/Riyadh' }).toJSDate();

function day(partial: Partial<Parameters<typeof evaluateAssignmentDay>[0]> = {}) {
  return evaluateAssignmentDay({
    assignmentStatus: 'SCHEDULED',
    workDate,
    employeeId: 'e1',
    now: after,
    scheduledStart: window.scheduledStart,
    gracePeriodMinutes: 5,
    hasCheckIn: false,
    exceptions: [],
    ...partial,
  });
}

const holiday: DayExceptionRecord = { workDate, employeeId: null, type: 'HOLIDAY' };

describe('day exceptions', () => {
  it('Holiday suppresses absence', () => {
    const result = day({ exceptions: [holiday] });
    assert.equal(result.isAbsent, false);
    assert.equal(result.status, 'HOLIDAY');
  });

  it('Holiday with attendance is HOLIDAY_WORK', () => {
    const result = day({ hasCheckIn: true, exceptions: [holiday] });
    assert.equal(result.status, 'HOLIDAY_WORK');
    assert.equal(result.holidayWork, true);
    assert.equal(result.isAbsent, false);
  });

  it('Sick Leave / Umra / Emergency Vacation / Vacation / Released / New suppress absence', () => {
    for (const type of [
      'SICK_LEAVE',
      'UMRA_LEAVE',
      'EMERGENCY_VACATION',
      'VACATION',
      'RELEASED',
      'NEW',
    ] as const) {
      const result = day({
        exceptions: [{ workDate, employeeId: 'e1', type }],
      });
      assert.equal(result.isAbsent, false, type);
      assert.equal(result.status, type);
    }
  });

  it('explicit Absent works', () => {
    const result = day({
      now: before,
      exceptions: [{ workDate, employeeId: 'e1', type: 'ABSENT' }],
    });
    assert.equal(result.isAbsent, true);
    assert.equal(result.status, 'ABSENT');
  });

  it('OFF remains non-absent', () => {
    const result = day({ assignmentStatus: 'OFF' });
    assert.equal(result.isAbsent, false);
    assert.equal(result.status, 'OFF');
  });

  it('Friday and Saturday are not automatically OFF', () => {
    assert.equal(isAutomaticWeekendOff(workDate), false);
    assert.equal(isAutomaticWeekendOff(friday), false);
    const saturdayScheduled = day({ workDate, assignmentStatus: 'SCHEDULED' });
    assert.equal(saturdayScheduled.status, 'ABSENT');
    assert.notEqual(saturdayScheduled.status, 'OFF');
    const fridayWindow = scheduledWindow(friday, '15:30', '03:30', true);
    const fridayAfter = DateTime.fromISO(`${friday}T18:00:00`, { zone: 'Asia/Riyadh' }).toJSDate();
    const fridayDay = evaluateAssignmentDay({
      assignmentStatus: 'SCHEDULED',
      workDate: friday,
      employeeId: 'e1',
      now: fridayAfter,
      scheduledStart: fridayWindow.scheduledStart,
      gracePeriodMinutes: 5,
      hasCheckIn: false,
      exceptions: [],
    });
    assert.equal(fridayDay.status, 'ABSENT');
    assert.notEqual(fridayDay.status, 'OFF');
  });

  it('Half Day uses the configured expected window', () => {
    const exception: DayExceptionRecord = {
      workDate,
      employeeId: 'e1',
      type: 'HALF_DAY',
      expectedStartTime: '15:30',
      expectedEndTime: '19:30',
    };
    const half = halfDayWindow(workDate, exception, '15:30', '03:30', true);
    assert.equal(half.expectedWorkMinutes, 240);
    const during = DateTime.fromISO(`${workDate}T17:00:00`, { zone: 'Asia/Riyadh' }).toJSDate();
    const afterHalf = DateTime.fromISO(`${workDate}T19:40:00`, { zone: 'Asia/Riyadh' }).toJSDate();
    const stillOpen = day({
      now: during,
      scheduledStart: half.scheduledStart,
      scheduledEnd: half.scheduledEnd,
      exceptions: [exception],
    });
    assert.equal(stillOpen.status, 'HALF_DAY');
    assert.equal(stillOpen.isAbsent, false);
    const missed = day({
      now: afterHalf,
      scheduledStart: half.scheduledStart,
      scheduledEnd: half.scheduledEnd,
      exceptions: [exception],
    });
    assert.equal(missed.status, 'ABSENT');
    assert.equal(missed.isAbsent, true);
  });

  it('unresolved PI does not silently excuse absence', () => {
    const result = day({
      exceptions: [],
    });
    assert.equal(result.isAbsent, true);
    assert.equal(result.status, 'ABSENT');
    assert.equal(result.excused, false);
  });
});

describe('tonight board exceptions', () => {
  const employee = {
    id: 'e1',
    fullName: 'Abdulaziz Abdullah H AlZahrani',
    employeeCode: '71326',
    badgeNumber: '71326',
    isActive: true,
    user: { role: 'EMPLOYEE', isActive: true },
  };
  const assignment: BoardAssignment = {
    id: 'a1',
    employeeId: 'e1',
    workDate,
    status: 'SCHEDULED',
    employee,
    project: { id: 'p1', name: 'Riyadh Night Site', locationLabel: 'Riyadh' },
    shift: {
      id: 's1',
      name: 'Night Shift 1',
      startTime: '15:30',
      endTime: '03:30',
      crossesMidnight: true,
      gracePeriodMinutes: 5,
    },
    attendance: [],
  };

  it('holiday without punch is not counted absent', () => {
    const board = buildTonightBoard({
      workDate,
      now: after,
      assignments: [assignment],
      exceptions: [holiday],
    });
    assert.equal(board.absent, 0);
    assert.equal(board.rows[0].statusPrimary, 'HOLIDAY');
  });

  it('holiday work counts overtime from worked minutes', () => {
    const board = buildTonightBoard({
      workDate,
      now: after,
      assignments: [
        {
          ...assignment,
          attendance: [
            {
              id: 'att1',
              checkInAt: new Date('2026-09-26T12:30:00.000Z'),
              checkOutAt: new Date('2026-09-27T00:30:00.000Z'),
              workedMinutes: 720,
              lateMinutes: 0,
              overtimeMinutes: 0,
              earlyLeaveMinutes: 0,
              statusPrimary: 'ON_TIME',
              flags: '["ON_TIME"]',
            },
          ],
        },
      ],
      exceptions: [holiday],
    });
    assert.equal(board.rows[0].statusPrimary, 'HOLIDAY_WORK');
    assert.equal(board.rows[0].overtimeMinutes, 720);
    assert.equal(board.overtime, 1);
    assert.equal(board.absent, 0);
  });
});
