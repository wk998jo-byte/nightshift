import { isScheduledAbsent } from './schedule-lookup';
import { scheduledWindow } from './attendance-calc';
import { fromAppWallTime, addCalendarDays } from './timezone';

export type DayExceptionType =
  | 'HOLIDAY'
  | 'ABSENT'
  | 'NEW'
  | 'SICK_LEAVE'
  | 'UMRA_LEAVE'
  | 'HALF_DAY'
  | 'EMERGENCY_VACATION'
  | 'VACATION'
  | 'RELEASED';

export type DayExceptionRecord = {
  workDate: string;
  employeeId: string | null;
  type: DayExceptionType;
  reason?: string | null;
  expectedStartTime?: string | null;
  expectedEndTime?: string | null;
  expectedWorkMinutes?: number | null;
};

export const EXCUSED_EXCEPTION_TYPES: DayExceptionType[] = [
  'HOLIDAY',
  'NEW',
  'SICK_LEAVE',
  'UMRA_LEAVE',
  'HALF_DAY',
  'EMERGENCY_VACATION',
  'VACATION',
  'RELEASED',
];

export const EXCEPTION_REPORT_STATUS: Record<DayExceptionType, string> = {
  HOLIDAY: 'HOLIDAY',
  ABSENT: 'ABSENT',
  NEW: 'NEW',
  SICK_LEAVE: 'SICK_LEAVE',
  UMRA_LEAVE: 'UMRA_LEAVE',
  HALF_DAY: 'HALF_DAY',
  EMERGENCY_VACATION: 'EMERGENCY_VACATION',
  VACATION: 'VACATION',
  RELEASED: 'RELEASED',
};

export function exceptionSuppressesAbsence(type: DayExceptionType): boolean {
  return type !== 'ABSENT';
}

/** Employee-specific exception wins over a company holiday. */
export function resolveDayException(
  workDate: string,
  employeeId: string,
  exceptions: DayExceptionRecord[]
): DayExceptionRecord | null {
  const personal = exceptions.find((e) => e.workDate === workDate && e.employeeId === employeeId);
  if (personal) return personal;
  return exceptions.find((e) => e.workDate === workDate && e.employeeId == null && e.type === 'HOLIDAY') || null;
}

export function halfDayWindow(
  workDate: string,
  exception: DayExceptionRecord,
  fallbackStart: string,
  fallbackEnd: string,
  crossesMidnight: boolean
): { scheduledStart: Date; scheduledEnd: Date; expectedWorkMinutes: number | null } {
  if (exception.expectedStartTime && exception.expectedEndTime) {
    const start = fromAppWallTime(workDate, exception.expectedStartTime);
    const endDate =
      exception.expectedEndTime < exception.expectedStartTime ? addCalendarDays(workDate, 1) : workDate;
    const end = fromAppWallTime(endDate, exception.expectedEndTime);
    const minutes = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
    return {
      scheduledStart: start,
      scheduledEnd: end,
      expectedWorkMinutes: exception.expectedWorkMinutes ?? minutes,
    };
  }
  const fallback = scheduledWindow(workDate, fallbackStart, fallbackEnd, crossesMidnight);
  if (exception.expectedWorkMinutes && exception.expectedWorkMinutes > 0) {
    return {
      scheduledStart: fallback.scheduledStart,
      scheduledEnd: new Date(fallback.scheduledStart.getTime() + exception.expectedWorkMinutes * 60000),
      expectedWorkMinutes: exception.expectedWorkMinutes,
    };
  }
  return {
    scheduledStart: fallback.scheduledStart,
    scheduledEnd: fallback.scheduledEnd,
    expectedWorkMinutes: exception.expectedWorkMinutes ?? null,
  };
}

export function evaluateAssignmentDay(input: {
  assignmentStatus: string;
  workDate: string;
  employeeId: string;
  now: Date;
  scheduledStart: Date;
  scheduledEnd?: Date;
  gracePeriodMinutes: number;
  hasCheckIn: boolean;
  exceptions: DayExceptionRecord[];
}): {
  status: string;
  isAbsent: boolean;
  excused: boolean;
  exception: DayExceptionRecord | null;
  holidayWork: boolean;
} {
  const exception = resolveDayException(input.workDate, input.employeeId, input.exceptions);

  if (input.assignmentStatus === 'OFF' && !exception) {
    return { status: 'OFF', isAbsent: false, excused: false, exception: null, holidayWork: false };
  }

  if (exception?.type === 'ABSENT') {
    return { status: 'ABSENT', isAbsent: true, excused: false, exception, holidayWork: false };
  }

  if (exception && exceptionSuppressesAbsence(exception.type)) {
    if (exception.type === 'HOLIDAY' && input.hasCheckIn) {
      return { status: 'HOLIDAY_WORK', isAbsent: false, excused: true, exception, holidayWork: true };
    }
    if (exception.type === 'HALF_DAY') {
      if (input.hasCheckIn) {
        return { status: 'HALF_DAY', isAbsent: false, excused: true, exception, holidayWork: false };
      }
      const absent = input.scheduledEnd
        ? input.now.getTime() >
          input.scheduledEnd.getTime() + input.gracePeriodMinutes * 60000
        : isScheduledAbsent({
            status: 'SCHEDULED',
            hasCheckIn: false,
            now: input.now,
            scheduledStart: input.scheduledStart,
            gracePeriodMinutes: input.gracePeriodMinutes,
          });
      return {
        status: absent ? 'ABSENT' : 'HALF_DAY',
        isAbsent: absent,
        excused: !absent,
        exception,
        holidayWork: false,
      };
    }
    if (input.hasCheckIn && exception.type !== 'HOLIDAY') {
      return {
        status: EXCEPTION_REPORT_STATUS[exception.type],
        isAbsent: false,
        excused: true,
        exception,
        holidayWork: false,
      };
    }
    return {
      status: EXCEPTION_REPORT_STATUS[exception.type],
      isAbsent: false,
      excused: true,
      exception,
      holidayWork: false,
    };
  }

  if (input.assignmentStatus === 'OFF') {
    return { status: 'OFF', isAbsent: false, excused: false, exception, holidayWork: false };
  }

  if (input.hasCheckIn) {
    return { status: 'PRESENT', isAbsent: false, excused: false, exception: null, holidayWork: false };
  }

  const absent = isScheduledAbsent({
    status: input.assignmentStatus,
    hasCheckIn: false,
    now: input.now,
    scheduledStart: input.scheduledStart,
    gracePeriodMinutes: input.gracePeriodMinutes,
  });
  return {
    status: absent ? 'ABSENT' : 'SCHEDULED',
    isAbsent: absent,
    excused: false,
    exception: null,
    holidayWork: false,
  };
}

/** Friday/Saturday remain whatever the official roster stored. */
export function isAutomaticWeekendOff(_workDate: string): boolean {
  return false;
}
