import type { Shift } from '@prisma/client';

export type ShiftChoice = 'SHIFT_1' | 'SHIFT_2' | 'OFF';

export const SHIFT_1_START = '15:30';
export const SHIFT_1_END = '03:30';
export const SHIFT_2_START = '19:30';
export const SHIFT_2_END = '07:30';

export type ShiftCatalog = {
  shift1: Shift | null;
  shift2: Shift | null;
};

export function classifyShift(shift: Pick<Shift, 'startTime' | 'endTime'>): Exclude<ShiftChoice, 'OFF'> | null {
  if (shift.startTime === SHIFT_1_START && shift.endTime === SHIFT_1_END) return 'SHIFT_1';
  if (shift.startTime === SHIFT_2_START && shift.endTime === SHIFT_2_END) return 'SHIFT_2';
  return null;
}

/** Map active DB shifts to SHIFT_1 / SHIFT_2 using real times, then startTime order. */
export function catalogFromShifts(shifts: Shift[]): ShiftCatalog {
  const active = shifts.filter((s) => s.isActive);
  const byTime1 = active.find((s) => classifyShift(s) === 'SHIFT_1') ?? null;
  const byTime2 = active.find((s) => classifyShift(s) === 'SHIFT_2') ?? null;
  if (byTime1 || byTime2) {
    return { shift1: byTime1, shift2: byTime2 };
  }
  const night = [...active].sort((a, b) => a.startTime.localeCompare(b.startTime));
  return { shift1: night[0] ?? null, shift2: night[1] ?? null };
}

export function shiftForChoice(catalog: ShiftCatalog, choice: Exclude<ShiftChoice, 'OFF'>): Shift | null {
  return choice === 'SHIFT_1' ? catalog.shift1 : catalog.shift2;
}

export function choiceForAssignment(
  shift: Pick<Shift, 'id' | 'startTime' | 'endTime'>,
  status: string,
  catalog: ShiftCatalog
): ShiftChoice {
  if (status === 'OFF') return 'OFF';
  if (catalog.shift1 && shift.id === catalog.shift1.id) return 'SHIFT_1';
  if (catalog.shift2 && shift.id === catalog.shift2.id) return 'SHIFT_2';
  return classifyShift(shift) ?? 'SHIFT_1';
}

export function canManageSchedule(role: string): boolean {
  return role === 'ADMIN' || role === 'HR' || role === 'SUPERVISOR';
}

/** Prisma filter: Shift Schedule lists only active real EMPLOYEE accounts. */
export const SHIFT_SCHEDULE_EMPLOYEE_WHERE = {
  isActive: true,
  user: { role: 'EMPLOYEE' as const, isActive: true },
};

export function isShiftScheduleEmployee(row: {
  isActive: boolean;
  user: { role: string; isActive: boolean } | null;
}): boolean {
  return row.isActive && row.user?.role === 'EMPLOYEE' && row.user.isActive;
}
