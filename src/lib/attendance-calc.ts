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
  | 'WORKING';

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
  manualCheckIn?: boolean;
  manualCheckOut?: boolean;
};

export type CalcResult = {
  workedMinutes: number | null;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
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
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      flags,
      statusPrimary: 'SCHEDULED',
    };
  }

  flags.push('PRESENT');
  if (input.manualCheckIn) flags.push('MANUAL_CHECKIN');

  const rawLate = Math.max(0, diffMinutes(input.checkInAt, input.scheduledStart));
  lateMinutes = lateMinutesAfterGrace(rawLate, input.gracePeriodMinutes);
  if (lateMinutes > 0) flags.push('LATE');
  else flags.push('ON_TIME');

  if (!input.checkOutAt) {
    flags.push('MISSING_CHECKOUT');
    flags.push('WORKING');
    return {
      workedMinutes: null,
      lateMinutes,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      flags,
      statusPrimary: lateMinutes > 0 ? 'LATE' : 'WORKING',
    };
  }

  if (input.manualCheckOut) flags.push('MANUAL_CHECKOUT');
  workedMinutes = Math.max(0, diffMinutes(input.checkOutAt, input.checkInAt));
  earlyLeaveMinutes = Math.max(0, diffMinutes(input.scheduledEnd, input.checkOutAt));
  overtimeMinutes = Math.max(0, diffMinutes(input.checkOutAt, input.scheduledEnd));

  if (earlyLeaveMinutes > 0) flags.push('EARLY_DEPARTURE');
  if (overtimeMinutes > 0) flags.push('OVERTIME');

  let statusPrimary = 'ON_TIME';
  if (lateMinutes > 0) statusPrimary = 'LATE';
  else if (earlyLeaveMinutes > 0) statusPrimary = 'EARLY_DEPARTURE';
  else if (overtimeMinutes > 0) statusPrimary = 'OVERTIME';
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
