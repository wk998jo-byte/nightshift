import { AssignmentStatus, type Shift } from '@prisma/client';
import {
  ATTENDANCE_BLOCKS_EDIT,
  assignmentWindow,
  candidateWorkDates,
  isScheduledAbsent,
  pickAssignmentForNow,
  type AssignmentWithShift,
  type ScheduleKind,
} from './schedule-lookup';
import { shiftForChoice, type ShiftChoice, type ShiftCatalog } from './shift-catalog';
import { catalogFromShifts } from './shift-catalog';
import { addCalendarDays, calendarDateInAppZone, getAppTimezone } from './timezone';
import { DateTime } from 'luxon';

export type AuditWriter = (input: {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  employeeId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}) => Promise<void>;

// Loose surface so PrismaClient remains assignable in API routes.
export type ScheduleDb = {
  shift: {
    findMany: (args?: any) => Promise<any[]>;
  };
  employee: {
    findUnique: (args?: any) => Promise<{
      id: string;
      defaultProjectId: string | null;
      isActive: boolean;
      fullName?: string;
      employeeCode?: string;
    } | null>;
  };
  project: {
    findFirst: (args?: any) => Promise<{ id: string } | null>;
  };
  employeeShiftAssignment: {
    findMany: (args?: any) => Promise<any[]>;
    findFirst: (args?: any) => Promise<any>;
    create: (args?: any) => Promise<any>;
    update: (args?: any) => Promise<any>;
  };
  attendanceRecord: {
    findFirst: (args?: any) => Promise<{ id: string } | null>;
  };
};

export function weekStart(anchorDate: string): string {
  const dt = DateTime.fromISO(anchorDate, { zone: getAppTimezone() });
  if (!dt.isValid) throw new Error(`Invalid date ${anchorDate}`);
  return dt.minus({ days: dt.weekday - 1 }).toFormat('yyyy-MM-dd');
}

export function weekDates(anchorDate: string): string[] {
  const start = DateTime.fromISO(weekStart(anchorDate), { zone: getAppTimezone() });
  return Array.from({ length: 7 }, (_, i) => start.plus({ days: i }).toFormat('yyyy-MM-dd'));
}

export function monthStart(anchorDate: string): string {
  const dt = DateTime.fromISO(anchorDate, { zone: getAppTimezone() });
  if (!dt.isValid) throw new Error(`Invalid date ${anchorDate}`);
  return dt.startOf('month').toFormat('yyyy-MM-dd');
}

export function monthEnd(anchorDate: string): string {
  const dt = DateTime.fromISO(anchorDate, { zone: getAppTimezone() });
  if (!dt.isValid) throw new Error(`Invalid date ${anchorDate}`);
  return dt.endOf('month').toFormat('yyyy-MM-dd');
}

export function monthDates(anchorDate: string): string[] {
  const start = monthStart(anchorDate);
  const end = monthEnd(anchorDate);
  const dates: string[] = [];
  for (let d = start; d <= end; d = addCalendarDays(d, 1)) dates.push(d);
  return dates;
}

export type SaveItem = {
  employeeId: string;
  workDate: string;
  choice: ShiftChoice;
};

export type CopyPlan = {
  items: SaveItem[];
  skippedLocked: number;
  skippedPast: number;
  skippedEmpty: number;
  wouldOverwrite: number;
};

function cellKey(employeeId: string, workDate: string) {
  return `${employeeId}:${workDate}`;
}

export function planPatternCopy(input: {
  employeeIds: string[];
  sourceDates: string[];
  targetDates: string[];
  sourceChoices: Map<string, ShiftChoice>;
  existing: Set<string>;
  locked: Set<string>;
  today: string;
  overwriteExisting: boolean;
}): CopyPlan {
  const items: SaveItem[] = [];
  let skippedLocked = 0;
  let skippedPast = 0;
  let skippedEmpty = 0;
  let wouldOverwrite = 0;
  const sourceLen = input.sourceDates.length;
  if (sourceLen === 0) return { items, skippedLocked, skippedPast, skippedEmpty, wouldOverwrite };

  for (const employeeId of input.employeeIds) {
    for (let i = 0; i < input.targetDates.length; i++) {
      const target = input.targetDates[i];
      const source = input.sourceDates[i % sourceLen];
      const key = cellKey(employeeId, target);
      const choice = input.sourceChoices.get(cellKey(employeeId, source));
      if (!choice) {
        skippedEmpty += 1;
        continue;
      }
      if (target < input.today) {
        skippedPast += 1;
        continue;
      }
      if (input.locked.has(key)) {
        skippedLocked += 1;
        continue;
      }
      if (input.existing.has(key) && !input.overwriteExisting) {
        wouldOverwrite += 1;
        continue;
      }
      items.push({ employeeId, workDate: target, choice });
    }
  }
  return { items, skippedLocked, skippedPast, skippedEmpty, wouldOverwrite };
}

export function previousWeekStart(anchorDate: string): string {
  return addCalendarDays(weekStart(anchorDate), -7);
}

export function datesAfterWeekUntilMonthEnd(weekAnchor: string): string[] {
  const week = weekDates(weekAnchor);
  const last = week[week.length - 1];
  const end = monthEnd(weekAnchor);
  const extra: string[] = [];
  for (let d = addCalendarDays(last, 1); d <= end; d = addCalendarDays(d, 1)) extra.push(d);
  return extra;
}

export async function loadShiftCatalog(prisma: ScheduleDb): Promise<ShiftCatalog> {
  const shifts = await prisma.shift.findMany({ where: { isActive: true } });
  return catalogFromShifts(shifts);
}

export async function loadEmployeeSchedule(
  prisma: ScheduleDb,
  employeeId: string,
  now = new Date()
): Promise<{
  kind: ScheduleKind;
  workDate: string;
  assignment: AssignmentWithShift | null;
  window: ReturnType<typeof assignmentWindow> | null;
}> {
  const [yesterday, today] = candidateWorkDates(now);
  const assignments = await prisma.employeeShiftAssignment.findMany({
    where: { employeeId, workDate: { in: [yesterday, today] } },
    include: { shift: true, project: true },
  });
  const picked = pickAssignmentForNow(assignments as AssignmentWithShift[], now);
  if (!picked) {
    return { kind: 'NO_SCHEDULE', workDate: today, assignment: null, window: null };
  }
  if (picked.status === 'OFF') {
    return { kind: 'OFF_DAY', workDate: picked.workDate, assignment: picked, window: null };
  }
  return {
    kind: 'SCHEDULED',
    workDate: picked.workDate,
    assignment: picked,
    window: assignmentWindow(picked),
  };
}

export { ATTENDANCE_BLOCKS_EDIT };

export async function saveScheduleItems(
  prisma: ScheduleDb,
  input: {
    actorId: string;
    items: SaveItem[];
    writeAudit: AuditWriter;
  }
): Promise<{
  saved: number;
  errors: Array<{ employeeId: string; workDate: string; error: string; employeeName?: string }>;
}> {
  const catalog = await loadShiftCatalog(prisma);
  const errors: Array<{ employeeId: string; workDate: string; error: string; employeeName?: string }> = [];
  let saved = 0;
  const audit = input.writeAudit;

  for (const item of input.items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.workDate)) {
      errors.push({ ...item, error: 'Invalid workDate' });
      continue;
    }
    if (item.choice !== 'SHIFT_1' && item.choice !== 'SHIFT_2' && item.choice !== 'OFF') {
      errors.push({ ...item, error: 'Invalid choice' });
      continue;
    }

    const employee = await prisma.employee.findUnique({ where: { id: item.employeeId } });
    if (!employee || !employee.isActive) {
      errors.push({ ...item, error: 'Employee not found', employeeName: employee?.fullName });
      continue;
    }

    const projectId =
      employee.defaultProjectId ||
      (await prisma.project.findFirst({ where: { isActive: true } }))?.id;
    if (!projectId) {
      errors.push({ ...item, error: 'No project available for assignment' });
      continue;
    }

    let shiftId: string;
    let status: AssignmentStatus;
    if (item.choice === 'OFF') {
      const placeholder = catalog.shift1 || catalog.shift2;
      if (!placeholder) {
        errors.push({ ...item, error: 'No production shift available' });
        continue;
      }
      shiftId = placeholder.id;
      status = AssignmentStatus.OFF;
    } else {
      const shift = shiftForChoice(catalog, item.choice);
      if (!shift) {
        errors.push({ ...item, error: `${item.choice} is not configured in the database` });
        continue;
      }
      shiftId = shift.id;
      status = AssignmentStatus.SCHEDULED;
    }

    const matches = await prisma.employeeShiftAssignment.findMany({
      where: { employeeId: item.employeeId, workDate: item.workDate },
      include: { shift: true, attendance: { select: { id: true, checkInAt: true } } },
    });
    if (matches.length > 1) {
      errors.push({
        ...item,
        error: 'Multiple assignments exist for this employee and date. Refusing to guess.',
      });
      continue;
    }
    const existing = matches[0] ?? null;

    if (!existing) {
      const created = await prisma.employeeShiftAssignment.create({
        data: {
          employeeId: item.employeeId,
          projectId,
          shiftId,
          workDate: item.workDate,
          status,
        },
      });
      await audit({
        actorId: input.actorId,
        action: 'SCHEDULE_CREATED',
        entityType: 'EmployeeShiftAssignment',
        entityId: created.id,
        employeeId: item.employeeId,
        newValue: { workDate: item.workDate, choice: item.choice, shiftId, status },
      });
      saved += 1;
      continue;
    }

    const same = existing.shiftId === shiftId && existing.status === status;
    if (same) continue;

    const hasAttendance =
      (existing.attendance &&
        existing.attendance.some((row: { checkInAt: Date | null }) => row.checkInAt)) ||
      !!(await prisma.attendanceRecord.findFirst({
        where: { employeeId: item.employeeId, assignmentId: existing.id, checkInAt: { not: null } },
      }));

    if (hasAttendance && (existing.shiftId !== shiftId || existing.status !== status)) {
      errors.push({
        ...item,
        employeeName: employee.fullName,
        error: ATTENDANCE_BLOCKS_EDIT,
      });
      continue;
    }

    const oldValue = {
      workDate: item.workDate,
      shiftId: existing.shiftId,
      status: existing.status,
    };
    await prisma.employeeShiftAssignment.update({
      where: { id: existing.id },
      data: { shiftId, status, projectId },
    });
    await audit({
      actorId: input.actorId,
      action: 'SCHEDULE_UPDATED',
      entityType: 'EmployeeShiftAssignment',
      entityId: existing.id,
      employeeId: item.employeeId,
      oldValue,
      newValue: { workDate: item.workDate, choice: item.choice, shiftId, status },
    });
    saved += 1;
  }

  return { saved, errors };
}

export function countAbsent(input: {
  assignments: Array<{
    status: string;
    employeeId: string;
    shift: { gracePeriodMinutes: number; startTime: string; endTime: string; crossesMidnight: boolean };
    workDate: string;
  }>;
  checkedInIds: Set<string>;
  now: Date;
}): number {
  let absent = 0;
  for (const a of input.assignments) {
    if (a.status !== 'SCHEDULED') continue;
    if (input.checkedInIds.has(`${a.employeeId}:${a.workDate}`) || input.checkedInIds.has(a.employeeId)) continue;
    const window = scheduledWindowSafe(a);
    if (
      isScheduledAbsent({
        status: a.status,
        hasCheckIn: false,
        now: input.now,
        scheduledStart: window.scheduledStart,
        scheduledEnd: window.scheduledEnd,
        gracePeriodMinutes: a.shift.gracePeriodMinutes,
      })
    ) {
      absent += 1;
    }
  }
  return absent;
}

function scheduledWindowSafe(a: {
  workDate: string;
  shift: { startTime: string; endTime: string; crossesMidnight: boolean };
}) {
  return assignmentWindow({
    workDate: a.workDate,
    shift: a.shift,
  } as AssignmentWithShift);
}

export function relevantWorkDatesForBoard(now = new Date()): string[] {
  const today = calendarDateInAppZone(now);
  return [addCalendarDays(today, -1), today];
}
