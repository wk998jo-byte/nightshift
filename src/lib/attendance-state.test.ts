import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { calculateAttendance, scheduledWindow } from './attendance-calc';
import {
  CHECKIN_TOO_EARLY_CODE,
  CURRENT_OPEN_CODE,
  EXCUSED_DAY_CODE,
  SHIFT_ENDED_CODE,
  effectiveScheduledWindow,
  employeeCheckInTimingView,
  evaluateLiveCheckIn,
  evaluateNormalQrCheckIn,
  flagsForOpenPunch,
  resolveAttendanceDisplay,
} from './attendance-state';
import { halfDayWindow, type DayExceptionRecord } from './day-status';
import { buildTonightBoard, type BoardAssignment } from './dashboard-board';
import { buildExportRows, type ExportAssignment } from './attendance-export';
import { classifyOpenAttendance } from './open-attendance';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

const workDate = '2026-09-26';
const window = scheduledWindow(workDate, '15:30', '03:30', true);

function riyadh(isoLocal: string): Date {
  return DateTime.fromISO(isoLocal, { zone: 'Asia/Riyadh' }).toJSDate();
}

function qr(now: Date, exception?: DayExceptionRecord | null) {
  return evaluateNormalQrCheckIn({
    scheduleKind: 'SCHEDULED',
    now,
    workDate,
    startTime: '15:30',
    endTime: '03:30',
    crossesMidnight: true,
    checkinWindowBeforeMinutes: 30,
    exception,
  });
}

const employee = {
  id: 'e1',
  fullName: 'Abdulaziz Abdullah H AlZahrani',
  employeeCode: '71326',
  badgeNumber: '71326',
  isActive: true,
  user: { role: 'EMPLOYEE', isActive: true },
};

function boardAsg(attendance: BoardAssignment['attendance'] = []): BoardAssignment {
  return {
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
      checkoutWindowAfterMinutes: 180,
    },
    attendance,
  };
}

function exportAsg(attendance: ExportAssignment['attendance'] = []): ExportAssignment {
  return {
    employeeId: 'e1',
    workDate,
    status: 'SCHEDULED',
    employee: {
      fullName: employee.fullName,
      employeeCode: employee.employeeCode,
      badgeNumber: employee.badgeNumber,
      isActive: true,
      user: employee.user,
    },
    project: { name: 'Riyadh Night Site' },
    shift: {
      name: 'Night Shift 1',
      startTime: '15:30',
      endTime: '03:30',
      crossesMidnight: true,
      gracePeriodMinutes: 5,
      checkoutWindowAfterMinutes: 180,
    },
    attendance,
  };
}

describe('Shift 1 check-in window and shift end', () => {
  it('14:59 QR IN => CHECKIN_TOO_EARLY', () => {
    const decision = qr(riyadh(`${workDate}T14:59:00`));
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.code, CHECKIN_TOO_EARLY_CODE);
      assert.ok((decision.minutesUntilOpen || 0) >= 1);
    }
  });

  it('15:00 QR IN => allowed', () => {
    const decision = qr(riyadh(`${workDate}T15:00:00`));
    assert.equal(decision.ok, true);
  });

  it('15:30 => on time and 15:35 on time and 15:36 late 6', () => {
    const onTime = calculateAttendance({
      ...window,
      checkInAt: riyadh(`${workDate}T15:30:00`),
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    const grace = calculateAttendance({
      ...window,
      checkInAt: riyadh(`${workDate}T15:35:00`),
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    const late = calculateAttendance({
      ...window,
      checkInAt: riyadh(`${workDate}T15:36:00`),
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    assert.equal(onTime.statusPrimary, 'WORKING');
    assert.equal(onTime.lateMinutes, 0);
    assert.equal(grace.lateMinutes, 0);
    assert.equal(late.lateMinutes, 6);
    assert.equal(late.statusPrimary, 'LATE');
    assert.equal(onTime.flags.includes('MISSING_CHECKOUT'), false);
    assert.equal(late.flags.includes('WORKING'), true);
    assert.deepEqual(
      onTime.flags.filter((f) => f === 'PRESENT' || f === 'ON_TIME' || f === 'WORKING').sort(),
      ['ON_TIME', 'PRESENT', 'WORKING']
    );
  });

  it('03:29 next day no prior IN => can still check in', () => {
    const decision = qr(riyadh('2026-09-27T03:29:00'));
    assert.equal(decision.ok, true);
  });

  it('03:31 no prior IN => SHIFT_ENDED', () => {
    const decision = qr(riyadh('2026-09-27T03:31:00'));
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.code, SHIFT_ENDED_CODE);
      assert.equal(decision.error, 'This shift has already ended.');
    }
  });
});

describe('open vs missing checkout after scheduled end', () => {
  const punch = {
    id: 'att-1',
    checkInAt: riyadh(`${workDate}T15:40:00`),
    checkOutAt: null as Date | null,
    scheduledEnd: window.scheduledEnd,
    checkoutWindowAfterMinutes: 180,
  };

  it('03:31 with existing IN => CURRENT OPEN', () => {
    assert.equal(classifyOpenAttendance(punch, riyadh('2026-09-27T03:31:00')), 'CURRENT_OPEN');
  });

  it('06:29 with existing IN => CURRENT OPEN', () => {
    assert.equal(classifyOpenAttendance(punch, riyadh('2026-09-27T06:29:00')), 'CURRENT_OPEN');
  });

  it('after 06:30 without OUT => MISSING_CHECKOUT', () => {
    assert.equal(classifyOpenAttendance(punch, riyadh('2026-09-27T06:31:00')), 'STALE_MISSING_CHECKOUT');
  });

  it('active open shift must not contain MISSING_CHECKOUT', () => {
    const calc = calculateAttendance({
      ...window,
      checkInAt: punch.checkInAt,
      checkOutAt: null,
      gracePeriodMinutes: 5,
    });
    assert.equal(calc.flags.includes('MISSING_CHECKOUT'), false);
    const display = resolveAttendanceDisplay({
      now: riyadh('2026-09-27T03:31:00'),
      punch: { ...calc, checkInAt: punch.checkInAt, checkOutAt: null, flags: calc.flags },
      scheduledEnd: window.scheduledEnd,
      checkoutWindowAfterMinutes: 180,
    });
    assert.equal(display.flags.includes('MISSING_CHECKOUT'), false);
    assert.equal(display.status, 'LATE');
  });

  it('stale open must display MISSING_CHECKOUT dynamically', () => {
    const display = resolveAttendanceDisplay({
      now: riyadh('2026-09-27T06:31:00'),
      punch: {
        checkInAt: punch.checkInAt,
        checkOutAt: null,
        workedMinutes: 1455,
        lateMinutes: 10,
        overtimeMinutes: 745,
        earlyLeaveMinutes: 0,
        statusPrimary: 'WORKING',
        flags: '["PRESENT","LATE","WORKING","MISSING_CHECKOUT"]',
      },
      scheduledEnd: window.scheduledEnd,
      checkoutWindowAfterMinutes: 180,
    });
    assert.equal(display.status, 'MISSING_CHECKOUT');
    assert.deepEqual(display.flags, ['MISSING_CHECKOUT']);
    assert.equal(display.workedMinutes, null);
    assert.equal(flagsForOpenPunch(['PRESENT', 'LATE', 'WORKING', 'MISSING_CHECKOUT']).includes('MISSING_CHECKOUT'), false);
  });
});

describe('half day calculations', () => {
  it('approved half-day times drive late/early/OT calculations', () => {
    const exception: DayExceptionRecord = {
      workDate,
      employeeId: 'e1',
      type: 'HALF_DAY',
      expectedStartTime: '15:30',
      expectedEndTime: '19:30',
    };
    const half = halfDayWindow(workDate, exception, '15:30', '03:30', true);
    const effective = effectiveScheduledWindow({
      workDate,
      startTime: '15:30',
      endTime: '03:30',
      crossesMidnight: true,
      exception,
    });
    assert.equal(effective.scheduledEnd.toISOString(), half.scheduledEnd.toISOString());
    const late = calculateAttendance({
      scheduledStart: half.scheduledStart,
      scheduledEnd: half.scheduledEnd,
      checkInAt: riyadh(`${workDate}T15:40:00`),
      checkOutAt: riyadh(`${workDate}T19:30:00`),
      gracePeriodMinutes: 5,
    });
    assert.equal(late.lateMinutes, 10);
    const early = calculateAttendance({
      scheduledStart: half.scheduledStart,
      scheduledEnd: half.scheduledEnd,
      checkInAt: riyadh(`${workDate}T15:30:00`),
      checkOutAt: riyadh(`${workDate}T19:00:00`),
      gracePeriodMinutes: 5,
    });
    assert.equal(early.earlyLeaveMinutes, 30);
    const ot = calculateAttendance({
      scheduledStart: half.scheduledStart,
      scheduledEnd: half.scheduledEnd,
      checkInAt: riyadh(`${workDate}T15:30:00`),
      checkOutAt: riyadh(`${workDate}T20:00:00`),
      gracePeriodMinutes: 5,
    });
    assert.equal(ot.overtimeMinutes, 30);
    const ended = qr(riyadh(`${workDate}T19:31:00`), exception);
    assert.equal(ended.ok, false);
    if (!ended.ok) assert.equal(ended.code, SHIFT_ENDED_CODE);
  });
});

describe('full-day exceptions', () => {
  it('Sick/Vacation/Umra/Emergency/Released/New block normal QR punch', () => {
    for (const type of [
      'SICK_LEAVE',
      'VACATION',
      'UMRA_LEAVE',
      'EMERGENCY_VACATION',
      'RELEASED',
      'NEW',
    ] as const) {
      const decision = qr(riyadh(`${workDate}T16:00:00`), {
        workDate,
        employeeId: 'e1',
        type,
      });
      assert.equal(decision.ok, false, type);
      if (!decision.ok) {
        assert.equal(decision.code, EXCUSED_DAY_CODE);
        assert.match(decision.error, /approved day status/i);
      }
    }
  });

  it('Holiday allows punch => HOLIDAY_WORK', () => {
    const decision = qr(riyadh(`${workDate}T16:00:00`), {
      workDate,
      employeeId: null,
      type: 'HOLIDAY',
    });
    assert.equal(decision.ok, true);
    const display = resolveAttendanceDisplay({
      now: riyadh(`${workDate}T16:00:00`),
      punch: {
        checkInAt: riyadh(`${workDate}T15:30:00`),
        checkOutAt: riyadh('2026-09-27T03:30:00'),
        workedMinutes: 720,
        lateMinutes: 0,
        overtimeMinutes: 0,
        earlyLeaveMinutes: 0,
        statusPrimary: 'ON_TIME',
        flags: '["ON_TIME"]',
      },
      scheduledEnd: window.scheduledEnd,
      holidayWork: true,
      exceptionType: 'HOLIDAY',
    });
    assert.equal(display.status, 'HOLIDAY_WORK');
  });

  it('OFF remains non-absent', () => {
    const decision = evaluateNormalQrCheckIn({
      scheduleKind: 'OFF_DAY',
      now: riyadh(`${workDate}T16:00:00`),
      workDate,
      startTime: '15:30',
      endTime: '03:30',
      crossesMidnight: true,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, 'OFF_DAY');
  });
});

describe('dashboard / export / display consistency', () => {
  it('WORKING LATE ON_TIME ABSENT MISSING_CHECKOUT and exceptions match', () => {
    const during = riyadh(`${workDate}T16:00:00`);
    const afterEnd = riyadh('2026-09-27T03:31:00');
    const afterCheckout = riyadh('2026-09-27T06:31:00');

    const openPunch = [
      {
        id: 'att-open',
        checkInAt: riyadh(`${workDate}T15:36:00`),
        checkOutAt: null,
        workedMinutes: null,
        lateMinutes: 6,
        overtimeMinutes: 0,
        earlyLeaveMinutes: 0,
        statusPrimary: 'LATE',
        flags: '["PRESENT","LATE","WORKING"]',
      },
    ];
    const boardOpen = buildTonightBoard({ workDate, now: during, assignments: [boardAsg(openPunch)] });
    const exportOpen = buildExportRows([exportAsg(openPunch)], during);
    assert.equal(boardOpen.rows[0].statusPrimary, 'LATE');
    assert.equal(exportOpen[0].status, 'LATE');
    assert.equal(boardOpen.currentlyWorking.length, 1);
    assert.equal(boardOpen.rows[0].flags.includes('MISSING_CHECKOUT'), false);

    const boardAbsent = buildTonightBoard({ workDate, now: afterEnd, assignments: [boardAsg()] });
    const exportAbsent = buildExportRows([exportAsg()], afterEnd);
    assert.equal(boardAbsent.rows[0].statusPrimary, 'ABSENT');
    assert.equal(exportAbsent[0].status, 'ABSENT');

    const boardStale = buildTonightBoard({
      workDate,
      now: afterCheckout,
      assignments: [boardAsg(openPunch)],
    });
    const exportStale = buildExportRows([exportAsg(openPunch)], afterCheckout);
    assert.equal(boardStale.rows[0].statusPrimary, 'MISSING_CHECKOUT');
    assert.equal(exportStale[0].status, 'MISSING_CHECKOUT');
    assert.equal(exportStale[0].worked, '—');
    assert.equal(boardStale.currentlyWorking.length, 0);

    const completed = [
      {
        id: 'att-done',
        checkInAt: riyadh(`${workDate}T15:30:00`),
        checkOutAt: riyadh('2026-09-27T03:30:00'),
        workedMinutes: 720,
        lateMinutes: 0,
        overtimeMinutes: 0,
        earlyLeaveMinutes: 0,
        statusPrimary: 'ON_TIME',
        flags: '["ON_TIME"]',
      },
    ];
    const boardDone = buildTonightBoard({ workDate, now: afterCheckout, assignments: [boardAsg(completed)] });
    const exportDone = buildExportRows([exportAsg(completed)], afterCheckout);
    assert.equal(boardDone.rows[0].statusPrimary, 'ON_TIME');
    assert.equal(exportDone[0].status, 'ON_TIME');

    const holiday: DayExceptionRecord = { workDate, employeeId: null, type: 'HOLIDAY' };
    const boardHoliday = buildTonightBoard({
      workDate,
      now: during,
      assignments: [boardAsg()],
      exceptions: [holiday],
    });
    const exportHoliday = buildExportRows([exportAsg()], during, [holiday]);
    assert.equal(boardHoliday.rows[0].statusPrimary, 'HOLIDAY');
    assert.equal(exportHoliday[0].status, 'HOLIDAY');
  });
});

describe('employee UI after shift end', () => {
  it('SHIFT_ENDED hides giant late counter and disables START SHIFT', () => {
    const view = employeeCheckInTimingView({
      eligibility: { allowed: false, code: SHIFT_ENDED_CODE },
      liveUntil: 0,
      liveLate: 745,
    });
    assert.equal(view.kind, 'SHIFT_ENDED');
    assert.equal(view.showLateMinutes, false);
    assert.equal(view.lateMinutes, 0);
    assert.equal(view.heading, 'Shift ended');
    assert.equal(view.detail, 'Check-in is no longer available for this shift.');
    assert.equal(view.startDisabled, true);
    assert.notEqual(view.lateMinutes, 745);
  });

  it('valid late during shift still shows correct late minutes', () => {
    const view = employeeCheckInTimingView({
      eligibility: { allowed: true, code: null },
      liveUntil: 0,
      liveLate: 6,
    });
    assert.equal(view.kind, 'LATE');
    assert.equal(view.showLateMinutes, true);
    assert.equal(view.lateMinutes, 6);
    assert.equal(view.startDisabled, false);
  });
});

function manual(
  now: Date,
  exception?: DayExceptionRecord | null,
  openRecords: Parameters<typeof evaluateLiveCheckIn>[0]['openRecords'] = []
) {
  return evaluateLiveCheckIn({
    scheduleKind: 'SCHEDULED',
    now,
    workDate,
    startTime: '15:30',
    endTime: '03:30',
    crossesMidnight: true,
    checkinWindowBeforeMinutes: 30,
    exception,
    openRecords,
  });
}

describe('manual check-in uses the same live eligibility as QR', () => {
  it('manual scheduled assignment required', () => {
    const decision = evaluateLiveCheckIn({
      scheduleKind: 'NO_SCHEDULE',
      now: riyadh(`${workDate}T16:00:00`),
      workDate,
      startTime: '15:30',
      endTime: '03:30',
      crossesMidnight: true,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, 'NO_SCHEDULE');
  });

  it('manual OFF denied', () => {
    const decision = evaluateLiveCheckIn({
      scheduleKind: 'OFF_DAY',
      now: riyadh(`${workDate}T16:00:00`),
      workDate,
      startTime: '15:30',
      endTime: '03:30',
      crossesMidnight: true,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, 'OFF_DAY');
  });

  it('manual too early denied', () => {
    const decision = manual(riyadh(`${workDate}T14:59:00`));
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, CHECKIN_TOO_EARLY_CODE);
  });

  it('manual after shift end denied', () => {
    const decision = manual(riyadh('2026-09-27T03:31:00'));
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, SHIFT_ENDED_CODE);
  });

  it('manual Sick/Vacation/etc denied', () => {
    for (const type of [
      'SICK_LEAVE',
      'VACATION',
      'UMRA_LEAVE',
      'EMERGENCY_VACATION',
      'RELEASED',
      'NEW',
    ] as const) {
      const decision = manual(riyadh(`${workDate}T16:00:00`), {
        workDate,
        employeeId: 'e1',
        type,
      });
      assert.equal(decision.ok, false, type);
      if (!decision.ok) assert.equal(decision.code, EXCUSED_DAY_CODE);
    }
  });

  it('manual Holiday allowed', () => {
    const decision = manual(riyadh(`${workDate}T16:00:00`), {
      workDate,
      employeeId: null,
      type: 'HOLIDAY',
    });
    assert.equal(decision.ok, true);
  });

  it('manual Half Day uses approved window', () => {
    const exception: DayExceptionRecord = {
      workDate,
      employeeId: 'e1',
      type: 'HALF_DAY',
      expectedStartTime: '15:30',
      expectedEndTime: '19:30',
    };
    const half = halfDayWindow(workDate, exception, '15:30', '03:30', true);
    const allowed = manual(riyadh(`${workDate}T16:00:00`), exception);
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      assert.equal(allowed.scheduledStart.toISOString(), half.scheduledStart.toISOString());
      assert.equal(allowed.scheduledEnd.toISOString(), half.scheduledEnd.toISOString());
    }
    const ended = manual(riyadh(`${workDate}T19:31:00`), exception);
    assert.equal(ended.ok, false);
    if (!ended.ok) assert.equal(ended.code, SHIFT_ENDED_CODE);
  });

  it('stale previous missing checkout does not block manual check-in', () => {
    const decision = manual(riyadh(`${workDate}T16:00:00`), null, [
      {
        id: 'att-stale',
        checkInAt: riyadh('2026-09-25T15:30:00'),
        checkOutAt: null,
        scheduledEnd: riyadh('2026-09-26T03:30:00'),
        checkoutWindowAfterMinutes: 180,
        workDate: '2026-09-25',
      },
    ]);
    assert.equal(decision.ok, true);
  });

  it('current open does block it', () => {
    const decision = manual(riyadh(`${workDate}T16:00:00`), null, [
      {
        id: 'att-open',
        checkInAt: riyadh(`${workDate}T15:30:00`),
        checkOutAt: null,
        scheduledEnd: window.scheduledEnd,
        checkoutWindowAfterMinutes: 180,
        workDate,
      },
    ]);
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.code, CURRENT_OPEN_CODE);
      assert.match(decision.error, /open shift/i);
    }
  });
});
