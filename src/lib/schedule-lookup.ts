import type { EmployeeShiftAssignment, Shift } from '@prisma/client';
import { scheduledWindow } from './attendance-calc';
import { addCalendarDays, calendarDateInAppZone, fromAppWallTime } from './timezone';

export type AssignmentWithShift = EmployeeShiftAssignment & {
  shift: Shift;
  project?: { id: string; name: string; locationLabel: string | null };
};

export type ScheduleKind = 'SCHEDULED' | 'OFF_DAY' | 'NO_SCHEDULE';

export function assignmentWindow(assignment: AssignmentWithShift) {
  return scheduledWindow(
    assignment.workDate,
    assignment.shift.startTime,
    assignment.shift.endTime,
    assignment.shift.crossesMidnight
  );
}

function closeOf(assignment: AssignmentWithShift): Date {
  const { scheduledEnd } = assignmentWindow(assignment);
  const after = assignment.shift.checkoutWindowAfterMinutes ?? 180;
  return new Date(scheduledEnd.getTime() + after * 60000);
}

function openOf(assignment: AssignmentWithShift): Date {
  const { scheduledStart } = assignmentWindow(assignment);
  const before = assignment.shift.checkinWindowBeforeMinutes ?? 30;
  return new Date(scheduledStart.getTime() - before * 60000);
}

/** Pick the assignment that applies at `now` without guessing a shift. */
export function pickAssignmentForNow(
  assignments: AssignmentWithShift[],
  now: Date
): AssignmentWithShift | null {
  if (assignments.length === 0) return null;

  const today = calendarDateInAppZone(now);
  const yesterday = addCalendarDays(today, -1);

  const containing = assignments.filter((a) => {
    if (a.status !== 'SCHEDULED') return false;
    return now >= openOf(a) && now <= closeOf(a);
  });
  if (containing.length === 1) return containing[0];
  if (containing.length > 1) {
    return containing.sort(
      (a, b) => assignmentWindow(a).scheduledStart.getTime() - assignmentWindow(b).scheduledStart.getTime()
    )[0];
  }

  const upcomingToday = assignments
    .filter((a) => a.status === 'SCHEDULED' && a.workDate === today)
    .filter((a) => assignmentWindow(a).scheduledStart.getTime() > now.getTime())
    .sort(
      (a, b) => assignmentWindow(a).scheduledStart.getTime() - assignmentWindow(b).scheduledStart.getTime()
    );
  if (upcomingToday[0]) return upcomingToday[0];

  const offToday = assignments.find((a) => a.status === 'OFF' && a.workDate === today);
  const offYesterday = assignments.find((a) => a.status === 'OFF' && a.workDate === yesterday);
  if (offYesterday && now < fromAppWallTime(today, '08:00')) return offYesterday;
  if (offToday) return offToday;

  return null;
}

export function checkInDeniedReason(kind: ScheduleKind): { code: string; error: string } | null {
  if (kind === 'NO_SCHEDULE') {
    return { code: 'NO_SCHEDULE', error: 'No shift scheduled. Contact supervisor.' };
  }
  if (kind === 'OFF_DAY') {
    return {
      code: 'OFF_DAY',
      error: 'You are scheduled OFF today. Regular check-in is not allowed.',
    };
  }
  return null;
}

export function candidateWorkDates(now: Date): [string, string] {
  const today = calendarDateInAppZone(now);
  return [addCalendarDays(today, -1), today];
}

export function isPastCheckInWindow(now: Date, scheduledStart: Date, gracePeriodMinutes: number): boolean {
  return now.getTime() > scheduledStart.getTime() + gracePeriodMinutes * 60000;
}

export function isScheduledAbsent(input: {
  status: string;
  hasCheckIn: boolean;
  now: Date;
  scheduledStart: Date;
  scheduledEnd: Date;
  gracePeriodMinutes?: number;
}): boolean {
  if (input.status !== 'SCHEDULED') return false;
  if (input.hasCheckIn) return false;
  return input.now.getTime() > input.scheduledEnd.getTime();
}

export const ATTENDANCE_BLOCKS_EDIT =
  'Attendance already exists for this date. Use attendance adjustment workflow.';
