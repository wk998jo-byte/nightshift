import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boardWorkDate,
  buildTonightBoard,
  filterBoardRows,
  pickActiveTerminal,
  type BoardAssignment,
} from './dashboard-board';
import { isShiftScheduleEmployee } from './shift-catalog';
import {
  datesAfterWeekUntilMonthEnd,
  monthDates,
  planPatternCopy,
  previousWeekStart,
  weekDates,
  weekStart,
} from './schedule-service';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

const shift1 = {
  id: 's1',
  name: 'Night Shift 1',
  startTime: '15:30',
  endTime: '03:30',
  crossesMidnight: true,
  gracePeriodMinutes: 5,
};
const shift2 = {
  id: 's2',
  name: 'Night Shift 2',
  startTime: '19:30',
  endTime: '07:30',
  crossesMidnight: true,
  gracePeriodMinutes: 5,
};

function person(
  id: string,
  opts: { active?: boolean; role?: string; userActive?: boolean; name?: string; code?: string } = {}
) {
  return {
    id,
    fullName: opts.name || id,
    employeeCode: opts.code || id,
    badgeNumber: opts.code || id,
    isActive: opts.active ?? true,
    user: { role: opts.role || 'EMPLOYEE', isActive: opts.userActive ?? true },
  };
}

function asg(partial: Partial<BoardAssignment> & Pick<BoardAssignment, 'id' | 'employeeId' | 'status' | 'employee' | 'shift'>): BoardAssignment {
  return {
    workDate: '2026-09-21',
    project: { id: 'p1', name: 'Riyadh Night Site', locationLabel: 'Riyadh' },
    attendance: [],
    ...partial,
  };
}

describe('tonight dashboard counts', () => {
  const now = new Date('2026-09-21T18:00:00.000Z'); // 21:00 Riyadh, after both check-in windows

  it('counts only active EMPLOYEE scheduled assignments', () => {
    const board = buildTonightBoard({
      workDate: '2026-09-21',
      now,
      assignments: [
        asg({
          id: 'a',
          employeeId: 'a',
          status: 'SCHEDULED',
          employee: person('a', { name: 'Real A', code: '71326' }),
          shift: shift1,
        }),
        asg({
          id: 'b',
          employeeId: 'b',
          status: 'SCHEDULED',
          employee: person('b', { name: 'Real B', code: '71343' }),
          shift: shift2,
        }),
        asg({
          id: 'c',
          employeeId: 'c',
          status: 'OFF',
          employee: person('c', { name: 'Real C', code: '71378' }),
          shift: shift1,
        }),
        asg({
          id: 'demo',
          employeeId: 'demo',
          status: 'SCHEDULED',
          employee: person('demo', { active: false, name: 'Demo Employee', code: 'EMP-0147' }),
          shift: shift1,
        }),
      ],
    });
    assert.equal(board.scheduled.length, 2);
    assert.equal(board.absent, 2);
    assert.equal(board.present, 0);
    assert.equal(board.rows.filter((r) => r.statusPrimary === 'ABSENT').length, 2);
    assert.ok(board.rows.some((r) => r.employeeCode === '71326' && r.statusPrimary === 'ABSENT'));
  });

  it('excludes OFF, NO_SCHEDULE, and inactive demo from scheduled and absent', () => {
    const board = buildTonightBoard({
      workDate: '2026-09-21',
      now,
      assignments: [
        asg({
          id: 'off',
          employeeId: 'c',
          status: 'OFF',
          employee: person('c'),
          shift: shift1,
        }),
        asg({
          id: 'demo',
          employeeId: 'd',
          status: 'SCHEDULED',
          employee: person('d', { active: false, userActive: false, role: 'EMPLOYEE', code: 'EMP-0148' }),
          shift: shift1,
        }),
      ],
    });
    assert.equal(board.scheduled.length, 0);
    assert.equal(board.absent, 0);
  });

  it('present and working only for scheduled check-ins', () => {
    const checkInAt = new Date('2026-09-21T12:40:00.000Z');
    const board = buildTonightBoard({
      workDate: '2026-09-21',
      now,
      assignments: [
        asg({
          id: 'a',
          employeeId: 'a',
          status: 'SCHEDULED',
          employee: person('a', { name: 'Real A', code: '71326' }),
          shift: shift1,
          attendance: [
            {
              id: 'att-1',
              checkInAt,
              checkOutAt: null,
              workedMinutes: null,
              lateMinutes: 10,
              overtimeMinutes: 0,
              earlyLeaveMinutes: 0,
              statusPrimary: 'LATE',
            },
          ],
        }),
        asg({
          id: 'b',
          employeeId: 'b',
          status: 'SCHEDULED',
          employee: person('b', { name: 'Real B', code: '71343' }),
          shift: shift2,
        }),
      ],
    });
    assert.equal(board.scheduled.length, 2);
    assert.equal(board.present, 1);
    assert.equal(board.working, 1);
    assert.equal(board.currentlyWorking.length, 1);
    assert.equal(board.currentlyWorking[0].code, '71326');
    assert.match(board.currentlyWorking[0].shiftLabel, /Shift 1/);
    assert.equal(board.absent, 1);
    assert.equal(board.rows.some((r) => r.statusPrimary === 'ABSENT' && r.employeeCode === '71343'), true);
  });

  it('filters by shift and status', () => {
    const rows = [
      {
        employeeName: 'A',
        employeeCode: '71326',
        statusPrimary: 'LATE',
        checkInAt: 'x',
        checkOutAt: null,
        shiftKey: 'SHIFT_1' as const,
      },
      {
        employeeName: 'B',
        employeeCode: '71343',
        statusPrimary: 'ABSENT',
        checkInAt: null,
        checkOutAt: null,
        shiftKey: 'SHIFT_2' as const,
      },
    ];
    assert.equal(filterBoardRows(rows, { shift: 'SHIFT_1' }).length, 1);
    assert.equal(filterBoardRows(rows, { status: 'ABSENT' })[0].employeeCode, '71343');
    assert.equal(filterBoardRows(rows, { q: '71326' })[0].employeeName, 'A');
  });

  it('uses a single night workDate, not yesterday+today', () => {
    const evening = new Date('2026-09-21T16:30:00.000Z'); // 19:30 Riyadh
    assert.equal(boardWorkDate(evening), '2026-09-21');
    const afterMidnight = new Date('2026-09-21T22:00:00.000Z'); // 01:00 Riyadh Sep 22
    assert.equal(boardWorkDate(afterMidnight), '2026-09-21');
  });

  it('does not mark a scheduled employee absent before the check-in window ends', () => {
    const board = buildTonightBoard({
      workDate: '2026-09-21',
      now: new Date('2026-09-21T13:00:00.000Z'), // 16:00 Riyadh; Shift 2 starts 19:30
      assignments: [
        asg({
          id: 'b',
          employeeId: 'b',
          status: 'SCHEDULED',
          employee: person('b', { name: 'Real B', code: '71343' }),
          shift: shift2,
        }),
      ],
    });
    assert.equal(board.scheduled.length, 1);
    assert.equal(board.absent, 0);
    assert.equal(board.rows.length, 0);
  });
});

describe('manual and people filters', () => {
  it('inactive demo users are excluded from active employee lists', () => {
    assert.equal(
      isShiftScheduleEmployee({
        isActive: false,
        user: { role: 'EMPLOYEE', isActive: false },
      }),
      false
    );
    assert.equal(
      isShiftScheduleEmployee({
        isActive: true,
        user: { role: 'EMPLOYEE', isActive: true },
      }),
      true
    );
  });
});

describe('QR terminal from DB', () => {
  it('picks the active DB terminal and not a legacy demo slug', () => {
    const picked = pickActiveTerminal([
      { slug: 'bin-quraya-dhahran', name: 'Legacy', isActive: false },
      { slug: 'main-gate', name: 'Gate Tablet', isActive: true },
    ]);
    assert.equal(picked?.slug, 'main-gate');
    assert.notEqual(picked?.slug, 'bin-quraya-dhahran');
  });
});

describe('schedule copy and month helpers', () => {
  it('Copy previous week maps weekday to weekday and skips locked/past', () => {
    const source = weekDates('2026-09-14');
    const target = weekDates('2026-09-21');
    const sourceChoices = new Map([
      ['e1:2026-09-14', 'SHIFT_1' as const],
      ['e1:2026-09-15', 'SHIFT_2' as const],
      ['e1:2026-09-16', 'OFF' as const],
    ]);
    const plan = planPatternCopy({
      employeeIds: ['e1'],
      sourceDates: source,
      targetDates: target,
      sourceChoices,
      existing: new Set(),
      locked: new Set(['e1:2026-09-21']),
      today: '2026-09-21',
      overwriteExisting: false,
    });
    assert.equal(plan.skippedLocked, 1);
    assert.ok(plan.items.some((i) => i.workDate === '2026-09-22' && i.choice === 'SHIFT_2'));
    assert.ok(plan.items.some((i) => i.workDate === '2026-09-23' && i.choice === 'OFF'));
    assert.equal(plan.items.some((i) => i.workDate === '2026-09-21'), false);
  });

  it('Repeat week to end of month does not duplicate keys', () => {
    const week = weekDates('2026-09-21');
    const extra = datesAfterWeekUntilMonthEnd('2026-09-21');
    assert.deepEqual(extra, ['2026-09-28', '2026-09-29', '2026-09-30']);
    const sourceChoices = new Map([
      ['e1:2026-09-21', 'SHIFT_1' as const],
      ['e1:2026-09-22', 'SHIFT_2' as const],
      ['e1:2026-09-23', 'OFF' as const],
    ]);
    const plan = planPatternCopy({
      employeeIds: ['e1'],
      sourceDates: week,
      targetDates: extra,
      sourceChoices,
      existing: new Set(['e1:2026-09-28']),
      locked: new Set(),
      today: '2026-09-21',
      overwriteExisting: false,
    });
    assert.equal(plan.wouldOverwrite, 1);
    assert.equal(plan.items.some((i) => i.workDate === '2026-09-28'), false);
    const keys = plan.items.map((i) => `${i.employeeId}:${i.workDate}`);
    assert.equal(keys.length, new Set(keys).size);
    const overwritten = planPatternCopy({
      ...{
        employeeIds: ['e1'],
        sourceDates: week,
        targetDates: extra,
        sourceChoices,
        existing: new Set(['e1:2026-09-28']),
        locked: new Set(),
        today: '2026-09-21',
      },
      overwriteExisting: true,
    });
    assert.ok(overwritten.items.some((i) => i.workDate === '2026-09-28' && i.choice === 'SHIFT_1'));
  });

  it('month dates cover the whole month', () => {
    const dates = monthDates('2026-09-21');
    assert.equal(dates[0], '2026-09-01');
    assert.equal(dates[dates.length - 1], '2026-09-30');
    assert.equal(dates.length, 30);
    assert.equal(previousWeekStart('2026-09-21'), weekStart('2026-09-14'));
  });
});
