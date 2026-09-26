import { isShiftScheduleEmployee, classifyShift } from './shift-catalog';
import {
  evaluateAssignmentDay,
  halfDayWindow,
  type DayExceptionRecord,
} from './day-status';
import { addCalendarDays, calendarDateInAppZone, getAppTimezone } from './timezone';
import { scheduledWindow } from './attendance-calc';
import { DateTime } from 'luxon';

export type BoardPerson = {
  id: string;
  fullName: string;
  employeeCode: string;
  badgeNumber?: string | null;
  isActive: boolean;
  user: { role: string; isActive: boolean } | null;
};

export type BoardShift = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  gracePeriodMinutes: number;
};

export type BoardAssignment = {
  id: string;
  employeeId: string;
  workDate: string;
  status: string;
  employee: BoardPerson;
  project: { id: string; name: string; locationLabel: string | null };
  shift: BoardShift;
  attendance: Array<{
    id: string;
    checkInAt: Date | null;
    checkOutAt: Date | null;
    workedMinutes: number | null;
    lateMinutes: number;
    overtimeMinutes: number;
    earlyLeaveMinutes: number;
    statusPrimary: string;
    flags?: string | null;
    manualOverride?: boolean;
  }>;
};

export type BoardRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  project: string;
  projectLocation: string | null;
  shiftKey: 'SHIFT_1' | 'SHIFT_2' | null;
  shiftLabel: string;
  scheduledStart: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number;
  overtimeMinutes: number;
  earlyLeaveMinutes: number;
  statusPrimary: string;
  flags: string[];
  manualOverride: boolean;
  virtualAbsent: boolean;
};

/** Night board date: before 08:00 Asia/Riyadh the night still belongs to yesterday. */
export function boardWorkDate(now: Date, explicit?: string | null): string {
  if (explicit && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const today = calendarDateInAppZone(now);
  const hour = DateTime.fromJSDate(now, { zone: getAppTimezone() }).hour;
  if (hour < 8) return addCalendarDays(today, -1);
  return today;
}

export function isDashboardEmployee(person: BoardPerson): boolean {
  return isShiftScheduleEmployee(person);
}

export function shiftKeyOf(shift: Pick<BoardShift, 'startTime' | 'endTime'>): 'SHIFT_1' | 'SHIFT_2' | null {
  return classifyShift(shift);
}

export function shiftDisplayLabel(shift: Pick<BoardShift, 'startTime' | 'endTime'>): string {
  const key = shiftKeyOf(shift);
  const times = `${shift.startTime} → ${shift.endTime}`;
  if (key === 'SHIFT_1') return `Shift 1\n${times}`;
  if (key === 'SHIFT_2') return `Shift 2\n${times}`;
  return times;
}

export function matchesStatusFilter(
  row: Pick<BoardRow, 'statusPrimary' | 'checkInAt' | 'checkOutAt'>,
  filter: string
): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'WORKING') return !!row.checkInAt && !row.checkOutAt && row.statusPrimary !== 'ABSENT';
  if (filter === 'ON_TIME') return row.statusPrimary === 'ON_TIME' || row.statusPrimary === 'PRESENT';
  return row.statusPrimary === filter;
}

export function matchesShiftFilter(
  row: { shiftKey?: 'SHIFT_1' | 'SHIFT_2' | null },
  filter: string
): boolean {
  if (filter === 'ALL' || filter === 'ALL_SHIFTS') return true;
  return row.shiftKey === filter;
}

export function pickActiveTerminal(
  terminals: Array<{ slug: string; name: string; isActive: boolean; projectId?: string }>
): { slug: string; name: string } | null {
  const active = terminals.find((t) => t.isActive) || terminals[0];
  return active ? { slug: active.slug, name: active.name } : null;
}

export function buildTonightBoard(input: {
  workDate: string;
  now: Date;
  assignments: BoardAssignment[];
  exceptions?: DayExceptionRecord[];
}): {
  scheduled: BoardAssignment[];
  present: number;
  late: number;
  absent: number;
  overtime: number;
  missingCheckout: number;
  working: number;
  rows: BoardRow[];
  currentlyWorking: Array<{
    id: string;
    name: string;
    code: string;
    badge: string;
    project: string;
    shiftLabel: string;
    checkInAt: string;
    currentWorkedMinutes: number;
    lateMinutes: number;
  }>;
  absentRows: BoardRow[];
} {
  const countable = input.assignments.filter(
    (a) => a.workDate === input.workDate && isDashboardEmployee(a.employee)
  );
  const scheduled = countable.filter((a) => a.status === 'SCHEDULED');

  const rows: BoardRow[] = [];
  const currentlyWorking: Array<{
    id: string;
    name: string;
    code: string;
    badge: string;
    project: string;
    shiftLabel: string;
    checkInAt: string;
    currentWorkedMinutes: number;
    lateMinutes: number;
  }> = [];

  let present = 0;
  let late = 0;
  let overtime = 0;
  let missingCheckout = 0;
  let working = 0;
  let absent = 0;
  const absentRows: BoardRow[] = [];

  const exceptions = input.exceptions || [];

  for (const a of scheduled) {
    let window = scheduledWindow(
      a.workDate,
      a.shift.startTime,
      a.shift.endTime,
      a.shift.crossesMidnight
    );
    const preview = evaluateAssignmentDay({
      assignmentStatus: a.status,
      workDate: a.workDate,
      employeeId: a.employeeId,
      now: input.now,
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      gracePeriodMinutes: a.shift.gracePeriodMinutes,
      hasCheckIn: false,
      exceptions,
    });
    if (preview.exception?.type === 'HALF_DAY') {
      window = halfDayWindow(
        a.workDate,
        preview.exception,
        a.shift.startTime,
        a.shift.endTime,
        a.shift.crossesMidnight
      );
    }
    const punch = a.attendance.find((r) => r.checkInAt) ?? null;
    const shiftKey = shiftKeyOf(a.shift);
    const shiftLabel = shiftDisplayLabel(a.shift);
    const day = evaluateAssignmentDay({
      assignmentStatus: a.status,
      workDate: a.workDate,
      employeeId: a.employeeId,
      now: input.now,
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      gracePeriodMinutes: a.shift.gracePeriodMinutes,
      hasCheckIn: !!punch?.checkInAt,
      exceptions,
    });

    if (punch?.checkInAt) {
      present += 1;
      const holidayOt =
        day.holidayWork && punch.workedMinutes != null ? punch.workedMinutes : punch.overtimeMinutes;
      if (punch.lateMinutes > 0) late += 1;
      if (holidayOt > 0) overtime += 1;
      if (!punch.checkOutAt) {
        if (input.now > window.scheduledEnd) {
          missingCheckout += 1;
        } else {
          working += 1;
          currentlyWorking.push({
            id: punch.id,
            name: a.employee.fullName,
            code: a.employee.employeeCode,
            badge: a.employee.badgeNumber || a.employee.employeeCode,
            project: a.project.name,
            shiftLabel: shiftLabel.replace('\n', ' · '),
            checkInAt: punch.checkInAt.toISOString(),
            currentWorkedMinutes: Math.floor((input.now.getTime() - punch.checkInAt.getTime()) / 60000),
            lateMinutes: punch.lateMinutes,
          });
        }
      }
      rows.push({
        id: punch.id,
        employeeId: a.employeeId,
        employeeName: a.employee.fullName,
        employeeCode: a.employee.employeeCode,
        project: a.project.name,
        projectLocation: a.project.locationLabel,
        shiftKey,
        shiftLabel,
        scheduledStart: window.scheduledStart.toISOString(),
        checkInAt: punch.checkInAt.toISOString(),
        checkOutAt: punch.checkOutAt ? punch.checkOutAt.toISOString() : null,
        workedMinutes: punch.workedMinutes,
        lateMinutes: punch.lateMinutes,
        overtimeMinutes: holidayOt,
        earlyLeaveMinutes: punch.earlyLeaveMinutes,
        statusPrimary: day.holidayWork
          ? 'HOLIDAY_WORK'
          : punch.checkOutAt
            ? punch.statusPrimary
            : input.now > window.scheduledEnd
              ? 'MISSING_CHECKOUT'
              : punch.lateMinutes > 0
                ? 'LATE'
                : 'WORKING',
        flags: (() => {
          try {
            const parsed = JSON.parse(punch.flags || '[]');
            return day.holidayWork ? [...parsed, 'HOLIDAY_WORK'] : parsed;
          } catch {
            return day.holidayWork ? ['HOLIDAY_WORK'] : [];
          }
        })(),
        manualOverride: !!punch.manualOverride,
        virtualAbsent: false,
      });
      continue;
    }

    if (day.excused && !day.isAbsent) {
      const row: BoardRow = {
        id: `exception:${a.id}`,
        employeeId: a.employeeId,
        employeeName: a.employee.fullName,
        employeeCode: a.employee.employeeCode,
        project: a.project.name,
        projectLocation: a.project.locationLabel,
        shiftKey,
        shiftLabel,
        scheduledStart: window.scheduledStart.toISOString(),
        checkInAt: null,
        checkOutAt: null,
        workedMinutes: null,
        lateMinutes: 0,
        overtimeMinutes: 0,
        earlyLeaveMinutes: 0,
        statusPrimary: day.status,
        flags: [day.status],
        manualOverride: false,
        virtualAbsent: true,
      };
      rows.push(row);
      continue;
    }
    if (!day.isAbsent) continue;
    absent += 1;
    const row: BoardRow = {
      id: `absent:${a.id}`,
      employeeId: a.employeeId,
      employeeName: a.employee.fullName,
      employeeCode: a.employee.employeeCode,
      project: a.project.name,
      projectLocation: a.project.locationLabel,
      shiftKey,
      shiftLabel,
      scheduledStart: window.scheduledStart.toISOString(),
      checkInAt: null,
      checkOutAt: null,
      workedMinutes: null,
      lateMinutes: 0,
      overtimeMinutes: 0,
      earlyLeaveMinutes: 0,
      statusPrimary: 'ABSENT',
      flags: ['ABSENT'],
      manualOverride: false,
      virtualAbsent: true,
    };
    rows.push(row);
    absentRows.push(row);
  }

  return {
    scheduled,
    present,
    late,
    absent,
    overtime,
    missingCheckout,
    working,
    rows,
    currentlyWorking,
    absentRows,
  };
}

export function filterBoardRows<
  T extends {
    employeeName: string;
    employeeCode: string;
    statusPrimary: string;
    checkInAt: string | null;
    checkOutAt: string | null;
    shiftKey?: 'SHIFT_1' | 'SHIFT_2' | null;
  },
>(rows: T[], input: { q?: string; status?: string; shift?: string }): T[] {
  const q = (input.q || '').trim().toLowerCase();
  return rows.filter((row) => {
    const matchQ =
      !q ||
      row.employeeName.toLowerCase().includes(q) ||
      row.employeeCode.toLowerCase().includes(q);
    return (
      matchQ &&
      matchesStatusFilter(row, input.status || 'ALL') &&
      matchesShiftFilter(row, input.shift || 'ALL')
    );
  });
}
