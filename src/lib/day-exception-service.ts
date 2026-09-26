import type { DayExceptionType } from './day-status';

export type ExceptionScope = 'HOLIDAY' | 'EMPLOYEE';

export type DayExceptionDraft = {
  workDate: string;
  scope: ExceptionScope;
  type: DayExceptionType;
  employeeId?: string | null;
  reason?: string | null;
  expectedStartTime?: string | null;
  expectedEndTime?: string | null;
  expectedWorkMinutes?: number | null;
};

export type PlannedDayException = {
  workDate: string;
  employeeId: string | null;
  type: DayExceptionType;
  reason: string | null;
  expectedStartTime: string | null;
  expectedEndTime: string | null;
  expectedWorkMinutes: number | null;
  auditAction: 'HOLIDAY_CREATED' | 'HOLIDAY_UPDATED' | 'DAY_EXCEPTION_CREATED' | 'DAY_EXCEPTION_UPDATED';
};

export type DayExceptionPlan =
  | { ok: false; error: string; status: number }
  | { ok: true; planned: PlannedDayException; existingId: string | null };

const TYPES: DayExceptionType[] = [
  'HOLIDAY',
  'ABSENT',
  'NEW',
  'SICK_LEAVE',
  'UMRA_LEAVE',
  'HALF_DAY',
  'EMERGENCY_VACATION',
  'VACATION',
  'RELEASED',
];

function isType(value: string): value is DayExceptionType {
  return TYPES.includes(value as DayExceptionType);
}

function isTime(value: string | null | undefined): boolean {
  return !!value && /^\d{2}:\d{2}$/.test(value);
}

export function planDayException(
  draft: DayExceptionDraft,
  existing: { id: string; type: string; employeeId: string | null; reason?: string | null } | null
): DayExceptionPlan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.workDate)) {
    return { ok: false, error: 'Invalid workDate', status: 400 };
  }
  if (!isType(draft.type)) return { ok: false, error: 'Unknown exception type', status: 400 };

  const companyHoliday = draft.scope === 'HOLIDAY' || (draft.type === 'HOLIDAY' && !draft.employeeId);
  if (draft.scope === 'HOLIDAY' && draft.type !== 'HOLIDAY') {
    return { ok: false, error: 'All-employees scope is only valid for Holiday', status: 400 };
  }
  if (!companyHoliday && !draft.employeeId) {
    return { ok: false, error: 'Employee is required', status: 400 };
  }
  if (companyHoliday && draft.type !== 'HOLIDAY') {
    return { ok: false, error: 'Company-wide exception must be Holiday', status: 400 };
  }

  if (draft.type === 'HALF_DAY') {
    const hasWindow = isTime(draft.expectedStartTime) && isTime(draft.expectedEndTime);
    const hasMinutes = (draft.expectedWorkMinutes || 0) > 0;
    if (!hasWindow && !hasMinutes) {
      return {
        ok: false,
        error: 'Half Day requires expected start/end or expected working minutes',
        status: 400,
      };
    }
  }

  const employeeId = companyHoliday ? null : draft.employeeId || null;
  const holiday = companyHoliday || draft.type === 'HOLIDAY';
  const auditAction = existing
    ? holiday && !employeeId
      ? 'HOLIDAY_UPDATED'
      : 'DAY_EXCEPTION_UPDATED'
    : holiday && !employeeId
      ? 'HOLIDAY_CREATED'
      : 'DAY_EXCEPTION_CREATED';

  return {
    ok: true,
    existingId: existing?.id ?? null,
    planned: {
      workDate: draft.workDate,
      employeeId,
      type: draft.type,
      reason: draft.reason?.trim() || null,
      expectedStartTime: draft.type === 'HALF_DAY' ? draft.expectedStartTime || null : null,
      expectedEndTime: draft.type === 'HALF_DAY' ? draft.expectedEndTime || null : null,
      expectedWorkMinutes:
        draft.type === 'HALF_DAY' && draft.expectedWorkMinutes && draft.expectedWorkMinutes > 0
          ? draft.expectedWorkMinutes
          : null,
      auditAction,
    },
  };
}

export function planRemoveDayException(existing: { id: string } | null): {
  ok: boolean;
  error?: string;
  status?: number;
  auditAction: 'DAY_EXCEPTION_REMOVED';
} {
  if (!existing) return { ok: false, error: 'Exception not found', status: 404, auditAction: 'DAY_EXCEPTION_REMOVED' };
  return { ok: true, auditAction: 'DAY_EXCEPTION_REMOVED' };
}
