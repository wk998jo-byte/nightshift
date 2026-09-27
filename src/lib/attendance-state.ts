import { calculateAttendance, scheduledWindow } from './attendance-calc';
import {
  halfDayWindow,
  resolveDayException,
  type DayExceptionRecord,
  type DayExceptionType,
} from './day-status';
import {
  isCurrentOpenAttendance,
  isStaleMissingCheckout,
  DEFAULT_CHECKOUT_WINDOW_AFTER_MINUTES,
} from './open-attendance';
import type { ScheduleKind } from './schedule-lookup';

export const DEFAULT_CHECKIN_WINDOW_BEFORE_MINUTES = 30;

export const SHIFT_ENDED_CODE = 'SHIFT_ENDED';
export const SHIFT_ENDED_ERROR = 'This shift has already ended.';
export const CHECKIN_TOO_EARLY_CODE = 'CHECKIN_TOO_EARLY';
export const EXCUSED_DAY_CODE = 'EXCUSED_DAY';
export const EXCUSED_DAY_ERROR =
  'An approved day status exists. Contact your supervisor if you are required to work.';

export const QR_BLOCKING_EXCEPTION_TYPES: DayExceptionType[] = [
  'SICK_LEAVE',
  'UMRA_LEAVE',
  'EMERGENCY_VACATION',
  'VACATION',
  'RELEASED',
  'NEW',
];

export function checkInOpensAt(
  scheduledStart: Date,
  checkinWindowBeforeMinutes?: number | null
): Date {
  const before =
    checkinWindowBeforeMinutes == null
      ? DEFAULT_CHECKIN_WINDOW_BEFORE_MINUTES
      : checkinWindowBeforeMinutes;
  return new Date(scheduledStart.getTime() - before * 60000);
}

export function minutesUntil(target: Date, now: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 60000));
}

export function effectiveScheduledWindow(input: {
  workDate: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  exception?: DayExceptionRecord | null;
}): { scheduledStart: Date; scheduledEnd: Date } {
  if (input.exception?.type === 'HALF_DAY') {
    const half = halfDayWindow(
      input.workDate,
      input.exception,
      input.startTime,
      input.endTime,
      input.crossesMidnight
    );
    return { scheduledStart: half.scheduledStart, scheduledEnd: half.scheduledEnd };
  }
  return scheduledWindow(input.workDate, input.startTime, input.endTime, input.crossesMidnight);
}

export type CheckInWindowDecision =
  | { ok: true }
  | {
      ok: false;
      code: typeof CHECKIN_TOO_EARLY_CODE;
      error: string;
      minutesUntilOpen: number;
      opensAt: Date;
    }
  | { ok: false; code: typeof SHIFT_ENDED_CODE; error: string };

export function evaluateCheckInWindow(input: {
  now: Date;
  scheduledStart: Date;
  scheduledEnd: Date;
  checkinWindowBeforeMinutes?: number | null;
}): CheckInWindowDecision {
  const opensAt = checkInOpensAt(input.scheduledStart, input.checkinWindowBeforeMinutes);
  if (input.now.getTime() < opensAt.getTime()) {
    const minutesUntilOpen = minutesUntil(opensAt, input.now);
    return {
      ok: false,
      code: CHECKIN_TOO_EARLY_CODE,
      error: `Check-in opens in ${minutesUntilOpen} minute${minutesUntilOpen === 1 ? '' : 's'}.`,
      minutesUntilOpen,
      opensAt,
    };
  }
  if (input.now.getTime() > input.scheduledEnd.getTime()) {
    return { ok: false, code: SHIFT_ENDED_CODE, error: SHIFT_ENDED_ERROR };
  }
  return { ok: true };
}

export function isQrBlockingException(type: DayExceptionType | null | undefined): boolean {
  return !!type && QR_BLOCKING_EXCEPTION_TYPES.includes(type);
}

export type NormalCheckInDecision =
  | {
      ok: true;
      scheduledStart: Date;
      scheduledEnd: Date;
    }
  | {
      ok: false;
      code:
        | 'NO_SCHEDULE'
        | 'OFF_DAY'
        | typeof EXCUSED_DAY_CODE
        | typeof CHECKIN_TOO_EARLY_CODE
        | typeof SHIFT_ENDED_CODE;
      error: string;
      minutesUntilOpen?: number;
      opensAt?: string;
    };

export function evaluateNormalQrCheckIn(input: {
  scheduleKind: ScheduleKind;
  now: Date;
  workDate: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  checkinWindowBeforeMinutes?: number | null;
  exception?: DayExceptionRecord | null;
}): NormalCheckInDecision {
  if (input.scheduleKind === 'NO_SCHEDULE') {
    return { ok: false, code: 'NO_SCHEDULE', error: 'No shift scheduled. Contact supervisor.' };
  }
  if (input.scheduleKind === 'OFF_DAY') {
    return {
      ok: false,
      code: 'OFF_DAY',
      error: 'You are scheduled OFF today. Regular check-in is not allowed.',
    };
  }
  if (isQrBlockingException(input.exception?.type)) {
    return { ok: false, code: EXCUSED_DAY_CODE, error: EXCUSED_DAY_ERROR };
  }

  const window = effectiveScheduledWindow({
    workDate: input.workDate,
    startTime: input.startTime,
    endTime: input.endTime,
    crossesMidnight: input.crossesMidnight,
    exception: input.exception,
  });
  const gate = evaluateCheckInWindow({
    now: input.now,
    scheduledStart: window.scheduledStart,
    scheduledEnd: window.scheduledEnd,
    checkinWindowBeforeMinutes: input.checkinWindowBeforeMinutes,
  });
  if (!gate.ok) {
    return {
      ok: false,
      code: gate.code,
      error: gate.error,
      minutesUntilOpen: 'minutesUntilOpen' in gate ? gate.minutesUntilOpen : undefined,
      opensAt: 'opensAt' in gate ? gate.opensAt.toISOString() : undefined,
    };
  }
  return { ok: true, scheduledStart: window.scheduledStart, scheduledEnd: window.scheduledEnd };
}

export function parseStoredFlags(raw: string | string[] | null | undefined): string[] {
  if (Array.isArray(raw)) return raw.filter((f) => typeof f === 'string');
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

export function flagsForOpenPunch(stored: string[]): string[] {
  const next = stored.filter((f) => f !== 'MISSING_CHECKOUT');
  if (!next.includes('PRESENT')) next.unshift('PRESENT');
  if (!next.includes('WORKING')) next.push('WORKING');
  if (!next.includes('ON_TIME') && !next.includes('LATE')) next.push('ON_TIME');
  return next;
}

export function flagsForStaleMissingCheckout(): string[] {
  return ['MISSING_CHECKOUT'];
}

export type DisplayPunch = {
  checkInAt: Date | null;
  checkOutAt: Date | null;
  workedMinutes: number | null;
  lateMinutes: number;
  overtimeMinutes: number;
  earlyLeaveMinutes: number;
  statusPrimary: string;
  flags?: string | string[] | null;
};

export type AttendanceDisplay = {
  status: string;
  flags: string[];
  workedMinutes: number | null;
  overtimeMinutes: number | null;
  earlyLeaveMinutes: number | null;
  lateMinutes: number;
};

export function resolveAttendanceDisplay(input: {
  now: Date;
  punch: DisplayPunch | null;
  scheduledEnd: Date;
  checkoutWindowAfterMinutes?: number | null;
  holidayWork?: boolean;
  dayStatus?: string;
  excused?: boolean;
  exceptionType?: string | null;
}): AttendanceDisplay {
  const punch = input.punch;
  const checkInAt = punch?.checkInAt ?? null;
  const checkOutAt = punch?.checkOutAt ?? null;
  const openState = {
    checkInAt,
    checkOutAt,
    scheduledEnd: input.scheduledEnd,
    checkoutWindowAfterMinutes: input.checkoutWindowAfterMinutes ?? DEFAULT_CHECKOUT_WINDOW_AFTER_MINUTES,
  };

  if (checkInAt && isStaleMissingCheckout(openState, input.now)) {
    return {
      status: 'MISSING_CHECKOUT',
      flags: flagsForStaleMissingCheckout(),
      workedMinutes: null,
      overtimeMinutes: null,
      earlyLeaveMinutes: null,
      lateMinutes: punch?.lateMinutes ?? 0,
    };
  }

  if (checkInAt && isCurrentOpenAttendance(openState, input.now)) {
    const late = punch?.lateMinutes ?? 0;
    return {
      status: late > 0 ? 'LATE' : 'WORKING',
      flags: flagsForOpenPunch(parseStoredFlags(punch?.flags)),
      workedMinutes: punch?.workedMinutes ?? null,
      overtimeMinutes: punch?.overtimeMinutes ?? 0,
      earlyLeaveMinutes: punch?.earlyLeaveMinutes ?? 0,
      lateMinutes: late,
    };
  }

  if (checkInAt && punch) {
    const stored = parseStoredFlags(punch.flags);
    const flags = [...stored];
    if (input.holidayWork && !flags.includes('HOLIDAY_WORK')) flags.push('HOLIDAY_WORK');
    if (input.exceptionType === 'HALF_DAY' && !flags.includes('HALF_DAY')) flags.push('HALF_DAY');
    const ot =
      input.holidayWork && punch.workedMinutes != null ? punch.workedMinutes : punch.overtimeMinutes;
    return {
      status: input.holidayWork ? 'HOLIDAY_WORK' : punch.statusPrimary,
      flags,
      workedMinutes: punch.workedMinutes,
      overtimeMinutes: ot,
      earlyLeaveMinutes: punch.earlyLeaveMinutes,
      lateMinutes: punch.lateMinutes,
    };
  }

  return {
    status: input.dayStatus || 'SCHEDULED',
    flags: input.dayStatus ? [input.dayStatus] : ['SCHEDULED'],
    workedMinutes: null,
    overtimeMinutes: null,
    earlyLeaveMinutes: null,
    lateMinutes: 0,
  };
}

export function calculateOpenPunch(input: {
  scheduledStart: Date;
  scheduledEnd: Date;
  checkInAt: Date;
  gracePeriodMinutes: number;
  manualCheckIn?: boolean;
}) {
  return calculateAttendance({
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    checkInAt: input.checkInAt,
    checkOutAt: null,
    gracePeriodMinutes: input.gracePeriodMinutes,
    manualCheckIn: input.manualCheckIn,
  });
}

export function exceptionForEmployee(
  workDate: string,
  employeeId: string,
  exceptions: DayExceptionRecord[]
): DayExceptionRecord | null {
  return resolveDayException(workDate, employeeId, exceptions);
}
