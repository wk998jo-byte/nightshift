import { requiredWorkMinutesForAttendance } from './attendance-calc';
import { resolveDayException, type DayExceptionRecord } from './day-status';

export type AttendanceDayPolicy = {
  requiredWorkMinutes: number;
  holidayWork: boolean;
  halfDay: boolean;
  exception: DayExceptionRecord | null;
};

export function resolveAttendanceDayPolicy(input: {
  workDate: string;
  employeeId: string;
  shiftMinWorkMinutes?: number | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  exceptions?: DayExceptionRecord[];
}): AttendanceDayPolicy {
  const exception = resolveDayException(
    input.workDate,
    input.employeeId,
    input.exceptions || []
  );
  const halfDay = exception?.type === 'HALF_DAY';
  const holidayWork = exception?.type === 'HOLIDAY';
  return {
    requiredWorkMinutes: requiredWorkMinutesForAttendance({
      shiftMinWorkMinutes: input.shiftMinWorkMinutes,
      exceptionType: exception?.type,
      exceptionExpectedWorkMinutes: exception?.expectedWorkMinutes,
      exceptionExpectedStartTime: exception?.expectedStartTime,
      exceptionExpectedEndTime: exception?.expectedEndTime,
      workDate: input.workDate,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
    }),
    holidayWork,
    halfDay,
    exception,
  };
}
