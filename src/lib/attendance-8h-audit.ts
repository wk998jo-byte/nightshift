import { calculateAttendance, type CalcResult } from './attendance-calc';
import { resolveAttendanceDayPolicy } from './attendance-policy';
import { parseStoredFlags } from './attendance-state';
import { isDemoEmployeeCode, isDemoEmployeeName } from './demo-employee';
import type { DayExceptionRecord } from './day-status';

export type CompletedAttendanceAuditRow = {
  id: string;
  workDate: string;
  employeeId?: string;
  employeeCode: string;
  employeeName: string;
  checkInAt: Date;
  checkOutAt: Date;
  scheduledStart: Date;
  scheduledEnd: Date;
  workedMinutes: number | null;
  lateMinutes: number;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  statusPrimary: string;
  flags: string | string[] | null;
  checkInMethod?: string | null;
  checkOutMethod?: string | null;
  gracePeriodMinutes: number;
  minWorkMinutes?: number | null;
  exceptions?: DayExceptionRecord[];
};

export type AttendanceMetricChange = {
  workDate: string;
  employeeCode: string;
  employeeName: string;
  checkInAt: Date;
  checkOutAt: Date;
  scheduledStart: Date;
  scheduledEnd: Date;
  oldWorked: number | null;
  newWorked: number | null;
  oldLate: number;
  newLate: number;
  oldShort: number | null;
  newShort: number | null;
  oldOt: number | null;
  newOt: number | null;
  oldPrimary: string;
  newPrimary: string;
  oldFlags: string[];
  newFlags: string[];
};

export type Attendance8hAuditSummary = {
  inspected: number;
  unchanged: number;
  workedChanged: number;
  lateChanged: number;
  shortChanged: number;
  otChanged: number;
  primaryChanged: number;
  flagsChanged: number;
  skippedOpenOrMissing: number;
  specialDay: number;
  skippedDemo: number;
  oldTotalOt: number;
  newTotalOt: number;
  oldTotalLate: number;
  newTotalLate: number;
  oldTotalShort: number;
  newTotalShort: number;
  byEmployee: Record<
    string,
    { name: string; inspected: number; changed: number; oldOt: number; newOt: number }
  >;
  changes: AttendanceMetricChange[];
};

function flagsEqual(a: string[], b: string[]): boolean {
  const left = [...a].filter((f) => f !== 'PUNCHING_ISSUE').sort();
  const right = [...b].filter((f) => f !== 'PUNCHING_ISSUE').sort();
  return left.length === right.length && left.every((flag, i) => flag === right[i]);
}

function num(value: number | null | undefined): number {
  return value == null || Number.isNaN(value) ? 0 : value;
}

export function proposeCompletedAttendanceMetrics(row: CompletedAttendanceAuditRow): CalcResult {
  const policy = resolveAttendanceDayPolicy({
    workDate: row.workDate,
    employeeId: row.employeeId || row.employeeCode,
    shiftMinWorkMinutes: row.minWorkMinutes,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    exceptions: row.exceptions,
  });
  return calculateAttendance({
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    checkInAt: row.checkInAt,
    checkOutAt: row.checkOutAt,
    gracePeriodMinutes: row.gracePeriodMinutes,
    requiredWorkMinutes: policy.requiredWorkMinutes,
    holidayWork: policy.holidayWork,
    halfDay: policy.halfDay,
    manualCheckIn: row.checkInMethod === 'MANUAL',
    manualCheckOut: row.checkOutMethod === 'MANUAL',
  });
}

export function summarizeAttendance8hAudit(input: {
  rows: CompletedAttendanceAuditRow[];
  skippedOpenOrMissing?: number;
}): Attendance8hAuditSummary {
  const summary: Attendance8hAuditSummary = {
    inspected: 0,
    unchanged: 0,
    workedChanged: 0,
    lateChanged: 0,
    shortChanged: 0,
    otChanged: 0,
    primaryChanged: 0,
    flagsChanged: 0,
    skippedOpenOrMissing: input.skippedOpenOrMissing || 0,
    specialDay: 0,
    skippedDemo: 0,
    oldTotalOt: 0,
    newTotalOt: 0,
    oldTotalLate: 0,
    newTotalLate: 0,
    oldTotalShort: 0,
    newTotalShort: 0,
    byEmployee: {},
    changes: [],
  };

  for (const row of input.rows) {
    if (isDemoEmployeeCode(row.employeeCode) || isDemoEmployeeName(row.employeeName)) {
      summary.skippedDemo += 1;
      continue;
    }
    const proposed = proposeCompletedAttendanceMetrics(row);
    const oldFlags = parseStoredFlags(row.flags);
    const exceptionType = resolveAttendanceDayPolicy({
      workDate: row.workDate,
      employeeId: row.employeeId || row.employeeCode,
      shiftMinWorkMinutes: row.minWorkMinutes,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      exceptions: row.exceptions,
    }).exception?.type;
    if (exceptionType) summary.specialDay += 1;

    summary.inspected += 1;
    summary.oldTotalOt += num(row.overtimeMinutes);
    summary.newTotalOt += num(proposed.overtimeMinutes);
    summary.oldTotalLate += num(row.lateMinutes);
    summary.newTotalLate += num(proposed.lateMinutes);
    summary.oldTotalShort += num(row.earlyLeaveMinutes);
    summary.newTotalShort += num(proposed.earlyLeaveMinutes);

    const by = (summary.byEmployee[row.employeeCode] ||= {
      name: row.employeeName,
      inspected: 0,
      changed: 0,
      oldOt: 0,
      newOt: 0,
    });
    by.inspected += 1;
    by.oldOt += num(row.overtimeMinutes);
    by.newOt += num(proposed.overtimeMinutes);

    const workedChanged = num(row.workedMinutes) !== num(proposed.workedMinutes);
    const lateChanged = num(row.lateMinutes) !== num(proposed.lateMinutes);
    const shortChanged = num(row.earlyLeaveMinutes) !== num(proposed.earlyLeaveMinutes);
    const otChanged = num(row.overtimeMinutes) !== num(proposed.overtimeMinutes);
    const primaryChanged = row.statusPrimary !== proposed.statusPrimary;
    const flagsChanged = !flagsEqual(oldFlags, proposed.flags);
    if (workedChanged) summary.workedChanged += 1;
    if (lateChanged) summary.lateChanged += 1;
    if (shortChanged) summary.shortChanged += 1;
    if (otChanged) summary.otChanged += 1;
    if (primaryChanged) summary.primaryChanged += 1;
    if (flagsChanged) summary.flagsChanged += 1;

    if (workedChanged || lateChanged || shortChanged || otChanged || primaryChanged || flagsChanged) {
      by.changed += 1;
      summary.changes.push({
        workDate: row.workDate,
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        checkInAt: row.checkInAt,
        checkOutAt: row.checkOutAt,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
        oldWorked: row.workedMinutes,
        newWorked: proposed.workedMinutes,
        oldLate: row.lateMinutes,
        newLate: proposed.lateMinutes,
        oldShort: row.earlyLeaveMinutes,
        newShort: proposed.earlyLeaveMinutes,
        oldOt: row.overtimeMinutes,
        newOt: proposed.overtimeMinutes,
        oldPrimary: row.statusPrimary,
        newPrimary: proposed.statusPrimary,
        oldFlags,
        newFlags: proposed.flags,
      });
    } else {
      summary.unchanged += 1;
    }
  }

  return summary;
}

function fmtTime(value: Date): string {
  return value.toISOString();
}

export function formatAttendance8hAuditReport(summary: Attendance8hAuditSummary): string {
  const shown = summary.changes.slice(0, 50);
  const lines = [
    'DRY RUN ONLY',
    'PRODUCTION WRITES: 0',
    '',
    `Completed records inspected: ${summary.inspected}`,
    `Unchanged: ${summary.unchanged}`,
    `Worked would change: ${summary.workedChanged}`,
    `Late would change: ${summary.lateChanged}`,
    `Short/early would change: ${summary.shortChanged}`,
    `OT would change: ${summary.otChanged}`,
    `Primary would change: ${summary.primaryChanged}`,
    `Flags would change: ${summary.flagsChanged}`,
    `Open / missing-checkout skipped: ${summary.skippedOpenOrMissing}`,
    `Special-day records: ${summary.specialDay}`,
    `Demo skipped: ${summary.skippedDemo}`,
    '',
    `Old total OT: ${summary.oldTotalOt}  ->  proposed: ${summary.newTotalOt}`,
    `Old total late: ${summary.oldTotalLate}  ->  proposed: ${summary.newTotalLate}`,
    `Old total short: ${summary.oldTotalShort}  ->  proposed: ${summary.newTotalShort}`,
    '',
    'By employee:',
  ];
  for (const [code, row] of Object.entries(summary.byEmployee).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `  ${code} ${row.name}: inspected ${row.inspected}, changed ${row.changed}, OT ${row.oldOt} -> ${row.newOt}`
    );
  }
  lines.push('');
  lines.push(
    summary.changes.length > 50
      ? `Changed rows (first 50 of ${summary.changes.length}):`
      : `Changed rows (${summary.changes.length}):`
  );
  if (shown.length === 0) {
    lines.push('  none');
  } else {
    lines.push(
      [
        'Work Date',
        'Code',
        'Employee',
        'IN',
        'OUT',
        'Sched Start',
        'Sched End',
        'Worked',
        'Late',
        'Short',
        'OT',
        'Primary',
        'Flags',
      ].join(' | ')
    );
    for (const row of shown) {
      lines.push(
        [
          row.workDate,
          row.employeeCode,
          row.employeeName,
          fmtTime(row.checkInAt),
          fmtTime(row.checkOutAt),
          fmtTime(row.scheduledStart),
          fmtTime(row.scheduledEnd),
          `${row.oldWorked} -> ${row.newWorked}`,
          `${row.oldLate} -> ${row.newLate}`,
          `${row.oldShort} -> ${row.newShort}`,
          `${row.oldOt} -> ${row.newOt}`,
          `${row.oldPrimary} -> ${row.newPrimary}`,
          `${row.oldFlags.join(',')} -> ${row.newFlags.join(',')}`,
        ].join(' | ')
      );
    }
  }
  lines.push('');
  lines.push('DRY RUN ONLY');
  lines.push('PRODUCTION WRITES: 0');
  return lines.join('\n');
}
