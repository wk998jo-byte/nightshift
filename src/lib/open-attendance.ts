import { calendarDateInAppZone } from './timezone';

export const DEFAULT_CHECKOUT_WINDOW_AFTER_MINUTES = 180;
export const STALE_MISSING_CHECKOUT_CODE = 'STALE_MISSING_CHECKOUT';
export const STALE_MISSING_CHECKOUT_ERROR =
  'Previous shift checkout is missing. Ask your supervisor to correct it.';

export type OpenAttendanceKind = 'CURRENT_OPEN' | 'STALE_MISSING_CHECKOUT' | 'CLOSED' | 'NO_CHECKIN';

export type ClassifiableAttendance = {
  id: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  scheduledEnd: Date;
  checkoutWindowAfterMinutes?: number | null;
  workDate?: string | null;
  assignment?: { workDate?: string | null } | null;
};

export function checkoutDeadline(
  scheduledEnd: Date,
  checkoutWindowAfterMinutes?: number | null
): Date {
  const after =
    checkoutWindowAfterMinutes == null ? DEFAULT_CHECKOUT_WINDOW_AFTER_MINUTES : checkoutWindowAfterMinutes;
  return new Date(scheduledEnd.getTime() + after * 60000);
}

export function classifyOpenAttendance(
  record: {
    checkInAt: Date | null;
    checkOutAt: Date | null;
    scheduledEnd: Date;
    checkoutWindowAfterMinutes?: number | null;
  },
  now: Date
): OpenAttendanceKind {
  if (!record.checkInAt) return 'NO_CHECKIN';
  if (record.checkOutAt) return 'CLOSED';
  const deadline = checkoutDeadline(record.scheduledEnd, record.checkoutWindowAfterMinutes);
  return now.getTime() <= deadline.getTime() ? 'CURRENT_OPEN' : 'STALE_MISSING_CHECKOUT';
}

export function isCurrentOpenAttendance(
  record: {
    checkInAt: Date | null;
    checkOutAt: Date | null;
    scheduledEnd: Date;
    checkoutWindowAfterMinutes?: number | null;
  },
  now: Date
): boolean {
  return classifyOpenAttendance(record, now) === 'CURRENT_OPEN';
}

export function isStaleMissingCheckout(
  record: {
    checkInAt: Date | null;
    checkOutAt: Date | null;
    scheduledEnd: Date;
    checkoutWindowAfterMinutes?: number | null;
  },
  now: Date
): boolean {
  return classifyOpenAttendance(record, now) === 'STALE_MISSING_CHECKOUT';
}

export function attendanceWorkDate(record: ClassifiableAttendance): string {
  return (
    record.workDate ||
    record.assignment?.workDate ||
    calendarDateInAppZone(record.checkInAt || record.scheduledEnd)
  );
}

export function classifyOpenRecords<T extends ClassifiableAttendance>(
  records: T[],
  now: Date
): { currentOpen: T | null; staleMissing: T[] } {
  const currentOpen =
    records.find((row) =>
      isCurrentOpenAttendance(
        {
          checkInAt: row.checkInAt,
          checkOutAt: row.checkOutAt,
          scheduledEnd: row.scheduledEnd,
          checkoutWindowAfterMinutes: row.checkoutWindowAfterMinutes,
        },
        now
      )
    ) || null;
  const staleMissing = records.filter((row) =>
    isStaleMissingCheckout(
      {
        checkInAt: row.checkInAt,
        checkOutAt: row.checkOutAt,
        scheduledEnd: row.scheduledEnd,
        checkoutWindowAfterMinutes: row.checkoutWindowAfterMinutes,
      },
      now
    )
  );
  return { currentOpen, staleMissing };
}

export type PreviousMissingCheckout = {
  attendanceId: string;
  workDate: string;
  checkInAt: string;
  scheduledEnd: string;
};

export function previousMissingCheckoutMeta(
  records: ClassifiableAttendance[],
  now: Date
): PreviousMissingCheckout | null {
  const { staleMissing } = classifyOpenRecords(records, now);
  const stale = [...staleMissing].sort(
    (a, b) => b.scheduledEnd.getTime() - a.scheduledEnd.getTime()
  )[0];
  if (!stale?.checkInAt) return null;
  return {
    attendanceId: stale.id,
    workDate: attendanceWorkDate(stale),
    checkInAt: stale.checkInAt.toISOString(),
    scheduledEnd: stale.scheduledEnd.toISOString(),
  };
}

export function employeeOpenShiftFromRecords<T extends ClassifiableAttendance>(
  records: T[],
  now: Date
): T | null {
  return classifyOpenRecords(records, now).currentOpen;
}

export function checkInBlockedBy(records: ClassifiableAttendance[], now: Date): ClassifiableAttendance | null {
  return classifyOpenRecords(records, now).currentOpen;
}

export type CheckoutTargetResult<T> =
  | { ok: true; record: T }
  | { ok: false; code: 'NO_OPEN_SHIFT' | typeof STALE_MISSING_CHECKOUT_CODE; error: string };

export function resolveCheckoutTarget<T extends ClassifiableAttendance>(
  records: T[],
  now: Date
): CheckoutTargetResult<T> {
  const { currentOpen, staleMissing } = classifyOpenRecords(records, now);
  if (currentOpen) return { ok: true, record: currentOpen };
  if (staleMissing.length > 0) {
    return {
      ok: false,
      code: STALE_MISSING_CHECKOUT_CODE,
      error: STALE_MISSING_CHECKOUT_ERROR,
    };
  }
  return { ok: false, code: 'NO_OPEN_SHIFT', error: 'No open shift to end' };
}

export function withShiftCheckoutWindow<T extends { shift?: { checkoutWindowAfterMinutes?: number | null } | null }>(
  record: T
): T & { checkoutWindowAfterMinutes: number } {
  return {
    ...record,
    checkoutWindowAfterMinutes:
      record.shift?.checkoutWindowAfterMinutes ?? DEFAULT_CHECKOUT_WINDOW_AFTER_MINUTES,
  };
}

export const MISSING_OUT_DASHBOARD_ACTION = 'FIX_OUT';

export function dashboardOpenPunchAction(row: {
  checkInAt: string | null;
  checkOutAt: string | null;
  virtualAbsent?: boolean;
}): typeof MISSING_OUT_DASHBOARD_ACTION | null {
  if (row.virtualAbsent) return null;
  if (row.checkInAt && !row.checkOutAt) return MISSING_OUT_DASHBOARD_ACTION;
  return null;
}

export function correctionPrefillFromMissingOut(input: {
  employeeId: string;
  workDate: string;
  attendanceId: string;
}) {
  return {
    employeeId: input.employeeId,
    workDate: input.workDate,
    attendanceId: input.attendanceId,
  };
}
