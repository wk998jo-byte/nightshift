import {
  addCalendarDays,
  appZoneMinutesOfDay,
  calendarDateInAppZone,
  formatTimeInAppZone,
  fromAppWallTime,
} from './timezone';

export type AttendanceFlags =
  | 'SCHEDULED'
  | 'PRESENT'
  | 'ON_TIME'
  | 'LATE'
  | 'ABSENT'
  | 'EARLY_DEPARTURE'
  | 'OVERTIME'
  | 'MISSING_CHECKOUT'
  | 'MANUAL_CHECKIN'
  | 'MANUAL_CHECKOUT'
  | 'ON_LEAVE'
  | 'OFF_DAY'
  | 'WORKING'
  | 'HOLIDAY_WORK'
  | 'HALF_DAY';

export const DEFAULT_REQUIRED_WORK_MINUTES = 480;

export function validRequiredWorkMinutes(
  value: number | null | undefined,
  fallback = DEFAULT_REQUIRED_WORK_MINUTES
): number {
  if (!Number.isFinite(value)) return fallback;
  const minutes = Math.floor(Number(value));
  if (minutes <= 0 || minutes > 24 * 60) return fallback;
  return minutes;
}

/**
 * Half Day required minutes, in order:
 * 1. approved expectedWorkMinutes when it is a positive integer
 * 2. duration of approved expectedStart/expectedEnd when those exist
 * 3. duration of the effective scheduled window already applied to the punch
 * Never force 480 for Half Day when an approved window can be measured.
 * Normal days: Shift.minWorkMinutes, or 480 when null/invalid.
 */
export function requiredWorkMinutesForAttendance(input: {
  shiftMinWorkMinutes?: number | null;
  exceptionType?: string | null;
  exceptionExpectedWorkMinutes?: number | null;
  exceptionExpectedStartTime?: string | null;
  exceptionExpectedEndTime?: string | null;
  workDate?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}): number {
  if (input.exceptionType === 'HALF_DAY') {
    if (
      Number.isFinite(input.exceptionExpectedWorkMinutes) &&
      Number(input.exceptionExpectedWorkMinutes) > 0
    ) {
      return Math.floor(Number(input.exceptionExpectedWorkMinutes));
    }
    if (input.workDate && input.exceptionExpectedStartTime && input.exceptionExpectedEndTime) {
      const start = fromAppWallTime(input.workDate, input.exceptionExpectedStartTime);
      const endDate =
        input.exceptionExpectedEndTime < input.exceptionExpectedStartTime
          ? addCalendarDays(input.workDate, 1)
          : input.workDate;
      const approvedWindowMinutes = diffMinutes(
        fromAppWallTime(endDate, input.exceptionExpectedEndTime),
        start
      );
      if (approvedWindowMinutes > 0) return approvedWindowMinutes;
    }
    const effectiveWindowMinutes = diffMinutes(input.scheduledEnd, input.scheduledStart);
    if (effectiveWindowMinutes > 0) return effectiveWindowMinutes;
  }
  return validRequiredWorkMinutes(input.shiftMinWorkMinutes);
}

export function parseTimeOnDate(workDate: string, hhmm: string): Date {
  return fromAppWallTime(workDate, hhmm);
}

export function scheduledWindow(
  workDate: string,
  startTime: string,
  endTime: string,
  crossesMidnight: boolean
): { scheduledStart: Date; scheduledEnd: Date } {
  const scheduledStart = parseTimeOnDate(workDate, startTime);
  const endDate = crossesMidnight ? addCalendarDays(workDate, 1) : workDate;
  const scheduledEnd = parseTimeOnDate(endDate, endTime);
  return { scheduledStart, scheduledEnd };
}

export function diffMinutes(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 60000);
}

/** Grace decides Late vs On Time. Once late, count from scheduled start (not grace). */
export function lateMinutesAfterGrace(rawLateMinutes: number, gracePeriodMinutes: number): number {
  if (rawLateMinutes <= 0) return 0;
  if (rawLateMinutes <= gracePeriodMinutes) return 0;
  return rawLateMinutes;
}

export function formatDuration(totalMinutes: number | null | undefined): string {
  if (totalMinutes == null || Number.isNaN(totalMinutes)) return '—';
  const h = Math.floor(Math.abs(totalMinutes) / 60);
  const m = Math.abs(totalMinutes) % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatTime(d: Date | string | null | undefined): string {
  return formatTimeInAppZone(d);
}

export type CalcInput = {
  scheduledStart: Date;
  scheduledEnd: Date;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  gracePeriodMinutes: number;
  requiredWorkMinutes?: number | null;
  holidayWork?: boolean;
  halfDay?: boolean;
  manualCheckIn?: boolean;
  manualCheckOut?: boolean;
};

export type CalcResult = {
  workedMinutes: number | null;
  lateMinutes: number;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  flags: AttendanceFlags[];
  statusPrimary: string;
};

export function calculateAttendance(input: CalcInput): CalcResult {
  const flags: AttendanceFlags[] = [];
  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  let overtimeMinutes = 0;
  let workedMinutes: number | null = null;

  if (!input.checkInAt) {
    flags.push('SCHEDULED');
    return {
      workedMinutes: null,
      lateMinutes: 0,
      earlyLeaveMinutes: null,
      overtimeMinutes: null,
      flags,
      statusPrimary: 'SCHEDULED',
    };
  }

  flags.push('PRESENT');
  if (input.manualCheckIn) flags.push('MANUAL_CHECKIN');
  if (input.holidayWork) flags.push('HOLIDAY_WORK');
  if (input.halfDay) flags.push('HALF_DAY');

  const rawLate = Math.max(0, diffMinutes(input.checkInAt, input.scheduledStart));
  lateMinutes = lateMinutesAfterGrace(rawLate, input.gracePeriodMinutes);
  if (lateMinutes > 0) flags.push('LATE');
  else flags.push('ON_TIME');

  if (!input.checkOutAt) {
    flags.push('WORKING');
    return {
      workedMinutes: null,
      lateMinutes,
      earlyLeaveMinutes: null,
      overtimeMinutes: null,
      flags,
      statusPrimary: lateMinutes > 0 ? 'LATE' : 'WORKING',
    };
  }

  if (input.manualCheckOut) flags.push('MANUAL_CHECKOUT');
  workedMinutes = Math.max(0, diffMinutes(input.checkOutAt, input.checkInAt));
  const requiredWorkMinutes = validRequiredWorkMinutes(input.requiredWorkMinutes);
  earlyLeaveMinutes = input.holidayWork
    ? 0
    : Math.max(0, requiredWorkMinutes - workedMinutes);
  overtimeMinutes = input.holidayWork
    ? workedMinutes
    : Math.max(0, workedMinutes - requiredWorkMinutes);

  if (earlyLeaveMinutes > 0) flags.push('EARLY_DEPARTURE');
  if (overtimeMinutes > 0) flags.push('OVERTIME');

  let statusPrimary = 'ON_TIME';
  if (lateMinutes > 0) statusPrimary = 'LATE';
  else if (earlyLeaveMinutes > 0) statusPrimary = 'EARLY_DEPARTURE';
  else statusPrimary = 'ON_TIME';

  return {
    workedMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    overtimeMinutes,
    flags,
    statusPrimary,
  };
}

/** Resolve which workDate a "now" belongs to for a night shift, in APP_TIMEZONE. */
export function resolveWorkDateForShift(
  now: Date,
  startTime: string,
  endTime: string,
  crossesMidnight: boolean
): string {
  void startTime;
  const dateKey = calendarDateInAppZone(now);
  if (!crossesMidnight) return dateKey;

  const [eh, em] = endTime.split(':').map(Number);
  const endMins = eh * 60 + em;
  const mins = appZoneMinutesOfDay(now);
  if (mins < endMins) {
    return addCalendarDays(dateKey, -1);
  }
  return dateKey;
}
