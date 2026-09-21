import { prisma } from './db';
import { getShiftTiming } from './schedule-timing';
import { loadEmployeeSchedule } from './schedule-service';

export { getShiftTiming };
export type { TimingPhase } from './schedule-timing';

/** Read the admin-assigned schedule. Never creates or guesses a shift. */
export async function getTonightAssignment(employeeId: string, now = new Date()) {
  return loadEmployeeSchedule(prisma, employeeId, now);
}

/** Does not auto-create assignments. Returns null unless the employee is SCHEDULED. */
export async function ensureTonightAssignment(employeeId: string, _projectId?: string) {
  void _projectId;
  const lookup = await getTonightAssignment(employeeId);
  if (lookup.kind !== 'SCHEDULED' || !lookup.assignment || !lookup.window) return null;
  const timing = getShiftTiming(
    new Date(),
    lookup.window.scheduledStart,
    lookup.window.scheduledEnd,
    lookup.assignment.shift.gracePeriodMinutes
  );
  return {
    assignment: lookup.assignment,
    night: lookup.assignment.shift,
    workDate: lookup.workDate,
    window: lookup.window,
    timing,
  };
}
