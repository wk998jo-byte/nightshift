import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AssignmentStatus, type Shift } from '@prisma/client';
import { scheduledWindow } from './attendance-calc';
import {
  checkInDeniedReason,
  isScheduledAbsent,
  pickAssignmentForNow,
  type AssignmentWithShift,
} from './schedule-lookup';
import { countAbsent, saveScheduleItems, weekDates, weekStart, type ScheduleDb } from './schedule-service';
import { canManageSchedule, catalogFromShifts, classifyShift, isShiftScheduleEmployee } from './shift-catalog';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

function utc(iso: string): Date {
  return new Date(iso);
}

function makeShift(partial: Partial<Shift> & Pick<Shift, 'id' | 'name' | 'startTime' | 'endTime'>): Shift {
  return {
    crossesMidnight: true,
    gracePeriodMinutes: 5,
    minWorkMinutes: null,
    overtimeRequiresApproval: false,
    checkinWindowBeforeMinutes: 30,
    checkoutWindowAfterMinutes: 180,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...partial,
  };
}

function makeAssignment(
  partial: Partial<AssignmentWithShift> & { shift: Shift; workDate: string }
): AssignmentWithShift {
  return {
    id: partial.id || 'asg-1',
    employeeId: partial.employeeId || 'emp-1',
    projectId: partial.projectId || 'proj-1',
    shiftId: partial.shift.id,
    workDate: partial.workDate,
    status: partial.status || AssignmentStatus.SCHEDULED,
    leaveType: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    shift: partial.shift,
    project: partial.project,
  };
}

const shift1 = makeShift({ id: 's1', name: 'Night Shift 1', startTime: '15:30', endTime: '03:30' });
const shift2 = makeShift({ id: 's2', name: 'Night Shift 2', startTime: '19:30', endTime: '07:30' });

function createFakeDb(seed: {
  assignments?: Array<
    AssignmentWithShift & { attendance?: Array<{ id: string; checkInAt: Date | null }> }
  >;
  attendance?: Array<{ id: string; employeeId: string; assignmentId: string; checkInAt: Date | null }>;
}): ScheduleDb & { assignments: Array<AssignmentWithShift & { attendance: Array<{ id: string; checkInAt: Date | null }> }> } {
  const assignments = (seed.assignments || []).map((a) => ({
    ...a,
    attendance: a.attendance || [],
  }));
  const attendance = seed.attendance || [];
  let seq = 1;

  return {
    assignments,
    shift: {
      findMany: async () => [shift1, shift2],
    },
    employee: {
      findUnique: async () => ({
        id: 'emp-1',
        defaultProjectId: 'proj-1',
        isActive: true,
      }),
    },
    project: {
      findFirst: async () => ({ id: 'proj-1' }),
    },
    employeeShiftAssignment: {
      findMany: async (args: unknown) => {
        const where = (args as { where?: { employeeId?: string; workDate?: string } }).where || {};
        return assignments.filter((a) => {
          if (where.employeeId && a.employeeId !== where.employeeId) return false;
          if (where.workDate && a.workDate !== where.workDate) return false;
          return true;
        });
      },
      findFirst: async () => assignments[0] ?? null,
      create: async (args: unknown) => {
        const data = (args as { data: AssignmentWithShift }).data;
        const row = makeAssignment({
          id: `new-${seq++}`,
          employeeId: data.employeeId,
          projectId: data.projectId,
          workDate: data.workDate,
          status: data.status,
          shift: data.shiftId === shift2.id ? shift2 : shift1,
        });
        const stored = { ...row, attendance: [] as Array<{ id: string; checkInAt: Date | null }> };
        assignments.push(stored);
        return stored;
      },
      update: async (args: unknown) => {
        const { where, data } = args as {
          where: { id: string };
          data: { shiftId?: string; status?: AssignmentStatus; projectId?: string };
        };
        const found = assignments.find((a) => a.id === where.id);
        if (!found) throw new Error('missing');
        if (data.shiftId) {
          found.shiftId = data.shiftId;
          found.shift = data.shiftId === shift2.id ? shift2 : shift1;
        }
        if (data.status) found.status = data.status;
        if (data.projectId) found.projectId = data.projectId;
        return found;
      },
    },
    attendanceRecord: {
      findFirst: async (args: unknown) => {
        const where = (args as { where?: { employeeId?: string; assignmentId?: string } }).where || {};
        const hit = attendance.find((r) => {
          if (where.employeeId && r.employeeId !== where.employeeId) return false;
          if (where.assignmentId && r.assignmentId !== where.assignmentId) return false;
          return r.checkInAt != null;
        });
        return hit ? { id: hit.id } : null;
      },
    },
  };
}

describe('shift catalog from real production times', () => {
  it('classifies Shift 1 15:30 → 03:30 and Shift 2 19:30 → 07:30', () => {
    assert.equal(classifyShift(shift1), 'SHIFT_1');
    assert.equal(classifyShift(shift2), 'SHIFT_2');
    const catalog = catalogFromShifts([shift1, shift2]);
    assert.equal(catalog.shift1?.id, 's1');
    assert.equal(catalog.shift2?.id, 's2');
  });
});

describe('schedule windows', () => {
  it('Shift 1 uses 15:30 → 03:30 and crosses midnight', () => {
    const { scheduledStart, scheduledEnd } = scheduledWindow('2026-09-21', '15:30', '03:30', true);
    assert.equal(scheduledStart.toISOString(), '2026-09-21T12:30:00.000Z');
    assert.equal(scheduledEnd.toISOString(), '2026-09-22T00:30:00.000Z');
  });

  it('Shift 2 uses 19:30 → 07:30 and crosses midnight', () => {
    const { scheduledStart, scheduledEnd } = scheduledWindow('2026-09-21', '19:30', '07:30', true);
    assert.equal(scheduledStart.toISOString(), '2026-09-21T16:30:00.000Z');
    assert.equal(scheduledEnd.toISOString(), '2026-09-22T04:30:00.000Z');
  });
});

describe('saveScheduleItems', () => {
  it('creates Shift 1 assignment', async () => {
    const db = createFakeDb({});
    const audits: Array<{ action: string; newValue?: unknown; oldValue?: unknown }> = [];
    const result = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-22', choice: 'SHIFT_1' }],
      writeAudit: async (row) => {
        audits.push(row);
      },
    });
    assert.equal(result.saved, 1);
    assert.equal(db.assignments[0].shiftId, 's1');
    assert.equal(db.assignments[0].status, 'SCHEDULED');
    assert.equal(audits[0].action, 'SCHEDULE_CREATED');
  });

  it('creates Shift 2 assignment', async () => {
    const db = createFakeDb({});
    const result = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-22', choice: 'SHIFT_2' }],
      writeAudit: async () => undefined,
    });
    assert.equal(result.saved, 1);
    assert.equal(db.assignments[0].shiftId, 's2');
  });

  it('creates OFF assignment', async () => {
    const db = createFakeDb({});
    const result = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-22', choice: 'OFF' }],
      writeAudit: async () => undefined,
    });
    assert.equal(result.saved, 1);
    assert.equal(db.assignments[0].status, 'OFF');
  });

  it('updates a future assignment', async () => {
    const existing = makeAssignment({ id: 'asg-future', workDate: '2026-09-28', shift: shift1 });
    const db = createFakeDb({ assignments: [{ ...existing, attendance: [] }] });
    const audits: Array<{ action: string; oldValue?: unknown; newValue?: unknown }> = [];
    const result = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-28', choice: 'SHIFT_2' }],
      writeAudit: async (row) => {
        audits.push(row);
      },
    });
    assert.equal(result.saved, 1);
    assert.equal(db.assignments[0].shiftId, 's2');
    assert.equal(audits[0].action, 'SCHEDULE_UPDATED');
  });

  it('blocks silent shift change when attendance exists', async () => {
    const existing = makeAssignment({ id: 'asg-used', workDate: '2026-09-21', shift: shift1 });
    const db = createFakeDb({
      assignments: [
        {
          ...existing,
          attendance: [{ id: 'att-1', checkInAt: utc('2026-09-21T12:40:00.000Z') }],
        },
      ],
    });
    const result = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-21', choice: 'SHIFT_2' }],
      writeAudit: async () => undefined,
    });
    assert.equal(result.saved, 0);
    assert.match(result.errors[0].error, /Attendance already exists/);
    assert.equal(db.assignments[0].shiftId, 's1');
  });

  it('saves a week of mixed shifts without duplicating assignments', async () => {
    const db = createFakeDb({});
    const dates = weekDates('2026-09-21');
    const choices = ['SHIFT_1', 'SHIFT_2', 'OFF', 'SHIFT_1', 'SHIFT_2', 'OFF', 'SHIFT_1'] as const;
    const result = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: dates.map((workDate, i) => ({ employeeId: 'emp-1', workDate, choice: choices[i] })),
      writeAudit: async () => undefined,
    });
    assert.equal(result.saved, 7);
    assert.equal(result.errors.length, 0);
    assert.equal(db.assignments.length, 7);
    const again = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: dates.map((workDate, i) => ({ employeeId: 'emp-1', workDate, choice: choices[i] })),
      writeAudit: async () => undefined,
    });
    assert.equal(again.saved, 0);
    assert.equal(db.assignments.length, 7);
  });

  it('saves a month range by updating the same employee/date row', async () => {
    const db = createFakeDb({});
    const first = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-22', choice: 'SHIFT_1' }],
      writeAudit: async () => undefined,
    });
    const second = await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-22', choice: 'OFF' }],
      writeAudit: async () => undefined,
    });
    assert.equal(first.saved, 1);
    assert.equal(second.saved, 1);
    assert.equal(db.assignments.length, 1);
    assert.equal(db.assignments[0].status, 'OFF');
  });

  it('writes audit for schedule create and update', async () => {
    const db = createFakeDb({});
    const audits: string[] = [];
    await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-23', choice: 'SHIFT_1' }],
      writeAudit: async (row) => {
        audits.push(row.action);
      },
    });
    await saveScheduleItems(db, {
      actorId: 'admin-1',
      items: [{ employeeId: 'emp-1', workDate: '2026-09-23', choice: 'OFF' }],
      writeAudit: async (row) => {
        audits.push(row.action);
      },
    });
    assert.deepEqual(audits, ['SCHEDULE_CREATED', 'SCHEDULE_UPDATED']);
  });
});

describe('check-in schedule rules', () => {
  it('denies check-in when there is no schedule', () => {
    const denied = checkInDeniedReason('NO_SCHEDULE');
    assert.equal(denied?.code, 'NO_SCHEDULE');
    assert.equal(denied?.error, 'No shift scheduled. Contact supervisor.');
    assert.equal(pickAssignmentForNow([], utc('2026-09-21T16:00:00.000Z')), null);
  });

  it('denies check-in on OFF', () => {
    const denied = checkInDeniedReason('OFF_DAY');
    assert.equal(denied?.code, 'OFF_DAY');
    const off = makeAssignment({
      workDate: '2026-09-21',
      shift: shift1,
      status: AssignmentStatus.OFF,
    });
    assert.equal(pickAssignmentForNow([off], utc('2026-09-21T16:00:00.000Z'))?.status, 'OFF');
  });

  it('picks Shift 1 after midnight using 15:30 → 03:30 window', () => {
    const asg = makeAssignment({ workDate: '2026-09-21', shift: shift1 });
    const picked = pickAssignmentForNow([asg], utc('2026-09-21T22:00:00.000Z'));
    assert.equal(picked?.shiftId, 's1');
    const window = scheduledWindow(picked!.workDate, picked!.shift.startTime, picked!.shift.endTime, true);
    assert.equal(window.scheduledStart.toISOString(), '2026-09-21T12:30:00.000Z');
    assert.equal(window.scheduledEnd.toISOString(), '2026-09-22T00:30:00.000Z');
  });

  it('picks Shift 2 after midnight using 19:30 → 07:30 window', () => {
    const asg = makeAssignment({ workDate: '2026-09-21', shift: shift2 });
    const picked = pickAssignmentForNow([asg], utc('2026-09-22T02:00:00.000Z'));
    assert.equal(picked?.shiftId, 's2');
    const window = scheduledWindow(picked!.workDate, picked!.shift.startTime, picked!.shift.endTime, true);
    assert.equal(window.scheduledStart.toISOString(), '2026-09-21T16:30:00.000Z');
    assert.equal(window.scheduledEnd.toISOString(), '2026-09-22T04:30:00.000Z');
  });
});

describe('absence uses assignments only', () => {
  const start = utc('2026-09-21T12:30:00.000Z');
  const end = utc('2026-09-22T00:30:00.000Z');

  it('Shift 1 15:36 and 16:00 with no check-in are not ABSENT', () => {
    assert.equal(
      isScheduledAbsent({
        status: 'SCHEDULED',
        hasCheckIn: false,
        now: utc('2026-09-21T12:36:00.000Z'),
        scheduledStart: start,
        scheduledEnd: end,
        gracePeriodMinutes: 5,
      }),
      false
    );
    assert.equal(
      isScheduledAbsent({
        status: 'SCHEDULED',
        hasCheckIn: false,
        now: utc('2026-09-21T13:00:00.000Z'),
        scheduledStart: start,
        scheduledEnd: end,
        gracePeriodMinutes: 5,
      }),
      false
    );
  });

  it('Shift 1 03:29 next day with no check-in is not ABSENT', () => {
    assert.equal(
      isScheduledAbsent({
        status: 'SCHEDULED',
        hasCheckIn: false,
        now: utc('2026-09-22T00:29:00.000Z'),
        scheduledStart: start,
        scheduledEnd: end,
        gracePeriodMinutes: 5,
      }),
      false
    );
  });

  it('scheduled employee without attendance after shift end is absent', () => {
    assert.equal(
      isScheduledAbsent({
        status: 'SCHEDULED',
        hasCheckIn: false,
        now: utc('2026-09-22T00:31:00.000Z'),
        scheduledStart: start,
        scheduledEnd: end,
        gracePeriodMinutes: 5,
      }),
      true
    );
    assert.equal(
      countAbsent({
        assignments: [
          {
            status: 'SCHEDULED',
            employeeId: 'emp-1',
            workDate: '2026-09-21',
            shift: shift1,
          },
        ],
        checkedInIds: new Set(),
        now: utc('2026-09-22T00:31:00.000Z'),
      }),
      1
    );
  });

  it('OFF employee is not absent', () => {
    assert.equal(
      isScheduledAbsent({
        status: 'OFF',
        hasCheckIn: false,
        now: utc('2026-09-22T00:31:00.000Z'),
        scheduledStart: start,
        scheduledEnd: end,
        gracePeriodMinutes: 5,
      }),
      false
    );
    assert.equal(
      countAbsent({
        assignments: [
          {
            status: 'OFF',
            employeeId: 'emp-1',
            workDate: '2026-09-21',
            shift: shift1,
          },
        ],
        checkedInIds: new Set(),
        now: utc('2026-09-21T12:40:00.000Z'),
      }),
      0
    );
  });

  it('employee without schedule is not absent', () => {
    assert.equal(
      countAbsent({
        assignments: [],
        checkedInIds: new Set(),
        now: utc('2026-09-21T12:40:00.000Z'),
      }),
      0
    );
  });
});

describe('schedule authorization', () => {
  it('allows Admin, HR, Supervisor and denies others', () => {
    assert.equal(canManageSchedule('ADMIN'), true);
    assert.equal(canManageSchedule('HR'), true);
    assert.equal(canManageSchedule('SUPERVISOR'), true);
    assert.equal(canManageSchedule('SECURITY'), false);
    assert.equal(canManageSchedule('EMPLOYEE'), false);
  });

  it('Shift Schedule lists only active real EMPLOYEE accounts', () => {
    assert.equal(
      isShiftScheduleEmployee({
        isActive: true,
        user: { role: 'EMPLOYEE', isActive: true },
      }),
      true
    );
    assert.equal(
      isShiftScheduleEmployee({
        isActive: false,
        user: { role: 'EMPLOYEE', isActive: true },
      }),
      false
    );
    assert.equal(
      isShiftScheduleEmployee({
        isActive: true,
        user: { role: 'EMPLOYEE', isActive: false },
      }),
      false
    );
    assert.equal(
      isShiftScheduleEmployee({
        isActive: true,
        user: { role: 'SUPERVISOR', isActive: true },
      }),
      false
    );
  });
});

describe('week helpers', () => {
  it('returns ISO week Monday–Sunday', () => {
    assert.equal(weekStart('2026-09-23'), '2026-09-21');
    assert.deepEqual(weekDates('2026-09-23'), [
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ]);
  });
});
