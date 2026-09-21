import { DateTime } from 'luxon';

export const DEFAULT_APP_TIMEZONE = 'Asia/Riyadh';

export function getAppTimezone(): string {
  const value = process.env.APP_TIMEZONE?.trim();
  return value || DEFAULT_APP_TIMEZONE;
}

function inAppZone(date: Date): DateTime {
  return DateTime.fromJSDate(date, { zone: getAppTimezone() });
}

/** Calendar date YYYY-MM-DD in APP_TIMEZONE for an instant. */
export function calendarDateInAppZone(date: Date): string {
  return inAppZone(date).toFormat('yyyy-MM-dd');
}

export function addCalendarDays(workDate: string, days: number): string {
  const [year, month, day] = workDate.split('-').map(Number);
  const dt = DateTime.fromObject({ year, month, day }, { zone: getAppTimezone() });
  if (!dt.isValid) {
    throw new Error(`Invalid workDate ${workDate}`);
  }
  return dt.plus({ days }).toFormat('yyyy-MM-dd');
}

/** Interpret wall-clock date+time in APP_TIMEZONE and return the UTC instant. */
export function fromAppWallTime(workDate: string, hhmm: string): Date {
  const [year, month, day] = workDate.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const dt = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone: getAppTimezone() }
  );
  if (!dt.isValid) {
    throw new Error(`Invalid wall time ${workDate} ${hhmm} in ${getAppTimezone()}`);
  }
  return dt.toJSDate();
}

export function appZoneMinutesOfDay(date: Date): number {
  const zoned = inAppZone(date);
  return zoned.hour * 60 + zoned.minute;
}

export function formatTimeInAppZone(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return inAppZone(date).toFormat('h:mm a');
}
