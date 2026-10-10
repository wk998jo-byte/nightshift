import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { formatDuration, formatTime, scheduledWindow } from './attendance-calc';
import { isDemoEmployeeCode, isDemoEmployeeName } from './demo-employee';
import { classifyShift } from './shift-catalog';
import { addCalendarDays, getAppTimezone } from './timezone';
import {
  evaluateAssignmentDay,
  type DayExceptionRecord,
} from './day-status';
import { isStaleMissingCheckout } from './open-attendance';
import { assignmentDisplayWindow, resolveAttendanceDisplay } from './attendance-state';

export const MAX_EXPORT_DAYS = 366;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const EXPORT_COLUMNS = [
  'Work Date',
  'Employee',
  'BN',
  'Shift',
  'Project',
  'Scheduled Start',
  'Scheduled End',
  'Check-in',
  'Check-out',
  'Worked',
  'Late (min)',
  'Short (min)',
  'OT (min)',
  'Status',
  'Flags',
] as const;

export const EXPORT_SUMMARY_COLUMNS = [
  'Employee',
  'BN',
  'Total Worked',
  'Total Late Minutes',
  'Total Short Minutes',
  'Total OT Minutes',
  'Late Days',
  'Missing Checkout',
] as const;

export type ExportRange =
  | { ok: true; from: string; to: string }
  | { ok: false; error: string };

export type ExportAssignment = {
  employeeId?: string;
  workDate: string;
  status: string;
  employee: {
    fullName: string;
    employeeCode: string;
    badgeNumber?: string | null;
    isActive?: boolean;
    user?: { role: string; isActive: boolean } | null;
  };
  project: { name: string };
  shift: {
    name: string;
    startTime: string;
    endTime: string;
    crossesMidnight: boolean;
    gracePeriodMinutes: number;
    checkoutWindowAfterMinutes?: number | null;
  };
  attendance: Array<{
    checkInAt: Date | string | null;
    checkOutAt: Date | string | null;
    scheduledStart?: Date | string | null;
    scheduledEnd?: Date | string | null;
    workedMinutes: number | null;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    overtimeMinutes: number;
    statusPrimary: string;
    flags?: string | null;
  }>;
};

export type ExportRow = {
  workDate: string;
  employeeId: string;
  employee: string;
  bn: string;
  shift: string;
  project: string;
  scheduledStart: string;
  scheduledEnd: string;
  checkIn: string;
  checkOut: string;
  worked: string;
  late: string;
  earlyLeave: string;
  ot: string;
  status: string;
  flags: string;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  missingCheckout: boolean;
};

export type ExportSummaryRow = {
  employeeId: string;
  employee: string;
  bn: string;
  totalWorkedMinutes: number;
  totalLateMinutes: number;
  totalShortMinutes: number;
  totalOtMinutes: number;
  lateDays: number;
  missingCheckout: number;
  totalWorked: string;
  totalOt: string;
};

export type ExportEmployeeOption = {
  id: string;
  fullName: string;
  employeeCode: string;
  badgeNumber?: string | null;
  isActive?: boolean;
  user?: { role: string; isActive: boolean } | null;
};

export function canExportAttendance(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'HR' || role === 'SUPERVISOR';
}

export function isIsoWorkDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const dt = DateTime.fromISO(value, { zone: getAppTimezone() });
  return dt.isValid && dt.toFormat('yyyy-MM-dd') === value;
}

export function parseExportRange(input: {
  from?: string | null;
  to?: string | null;
  date?: string | null;
}): ExportRange {
  const date = input.date?.trim() || '';
  const fromRaw = input.from?.trim() || date;
  const toRaw = input.to?.trim() || date;
  if (!fromRaw || !toRaw) return { ok: false, error: 'from and to are required' };
  if (!isIsoWorkDate(fromRaw) || !isIsoWorkDate(toRaw)) {
    return { ok: false, error: 'Invalid date range' };
  }
  if (fromRaw > toRaw) return { ok: false, error: 'from must be on or before to' };
  const days = countInclusiveDays(fromRaw, toRaw);
  if (days > MAX_EXPORT_DAYS) return { ok: false, error: 'Date range too large' };
  return { ok: true, from: fromRaw, to: toRaw };
}

export function countInclusiveDays(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addCalendarDays(d, 1)) n += 1;
  return n;
}

export function enumerateWorkDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addCalendarDays(d, 1)) dates.push(d);
  return dates;
}

export function sanitizeExportFilenamePart(value: string | null | undefined): string {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 40);
  return cleaned || 'employee';
}

export function exportFilename(
  from: string,
  to: string,
  options?: { employeeCode?: string | null }
): string {
  const range = `${from}-to-${to}`;
  if (options?.employeeCode) {
    return `attendance-${sanitizeExportFilenamePart(options.employeeCode)}-${range}.csv`;
  }
  return `attendance-all-${range}.csv`;
}

export function exportAssignmentWhere(input: {
  from: string;
  to: string;
  projectId?: string | null;
  employeeId?: string | null;
}): Prisma.EmployeeShiftAssignmentWhereInput {
  return {
    status: { in: ['SCHEDULED', 'OFF'] },
    workDate: { gte: input.from, lte: input.to },
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.employeeId ? { employeeId: input.employeeId } : {}),
  };
}

export function resolveExportEmployee(
  employee: ExportEmployeeOption | null | undefined
): { ok: true; employee: ExportEmployeeOption } | { ok: false; error: string } {
  if (!employee?.id) return { ok: false, error: 'Invalid employee' };
  if (!includeExportEmployee(employee)) return { ok: false, error: 'Invalid employee' };
  return { ok: true, employee };
}

export function listExportableEmployees<T extends ExportEmployeeOption>(employees: T[]): T[] {
  return employees
    .filter((row) => includeExportEmployee(row))
    .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.employeeCode.localeCompare(b.employeeCode));
}

export function exportEmployeeLabel(employee: {
  fullName: string;
  badgeNumber?: string | null;
  employeeCode: string;
}): string {
  return `${employee.fullName} — ${employee.badgeNumber || employee.employeeCode}`;
}

export function csvEscape(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function exportShiftName(shift: { name: string; startTime: string; endTime: string }): string {
  const key = classifyShift(shift);
  if (key === 'SHIFT_1') return 'Shift 1';
  if (key === 'SHIFT_2') return 'Shift 2';
  return shift.name || `${shift.startTime} → ${shift.endTime}`;
}

export function includeExportEmployee(person: ExportAssignment['employee']): boolean {
  if (isDemoEmployeeCode(person.employeeCode) || isDemoEmployeeName(person.fullName)) return false;
  if (person.user && person.user.role !== 'EMPLOYEE') return false;
  return true;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function emptyMetrics() {
  return {
    workedMinutes: null as number | null,
    lateMinutes: null as number | null,
    earlyLeaveMinutes: null as number | null,
    overtimeMinutes: null as number | null,
    missingCheckout: false,
  };
}

function excusedDashes(identity: {
  workDate: string;
  employeeId: string;
  employee: string;
  bn: string;
  project: string;
}, extra: { shift: string; scheduledStart: string; scheduledEnd: string; status: string; flags: string }): ExportRow {
  return {
    ...identity,
    ...extra,
    checkIn: '—',
    checkOut: '—',
    worked: '—',
    late: '—',
    earlyLeave: '—',
    ot: '—',
    ...emptyMetrics(),
  };
}

export function buildExportRows(
  assignments: ExportAssignment[],
  now = new Date(),
  exceptions: DayExceptionRecord[] = [],
  options?: { employeeId?: string | null }
): ExportRow[] {
  const rows: ExportRow[] = [];
  const onlyEmployeeId = options?.employeeId?.trim() || '';
  for (const a of assignments) {
    if (a.status !== 'SCHEDULED' && a.status !== 'OFF') continue;
    if (!includeExportEmployee(a.employee)) continue;
    if (onlyEmployeeId && (a.employeeId || '') !== onlyEmployeeId) continue;

    const identity = {
      workDate: a.workDate,
      employeeId: a.employeeId || '',
      employee: a.employee.fullName,
      bn: a.employee.badgeNumber || a.employee.employeeCode,
      project: a.project.name,
    };

    let window = scheduledWindow(
      a.workDate,
      a.shift.startTime,
      a.shift.endTime,
      a.shift.crossesMidnight
    );
    const preview = evaluateAssignmentDay({
      assignmentStatus: a.status,
      workDate: a.workDate,
      employeeId: a.employeeId || '',
      now,
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      gracePeriodMinutes: a.shift.gracePeriodMinutes,
      hasCheckIn: false,
      exceptions,
    });
    const punch = a.attendance.find((r) => r.checkInAt) ?? null;
    window = assignmentDisplayWindow({
      workDate: a.workDate,
      startTime: a.shift.startTime,
      endTime: a.shift.endTime,
      crossesMidnight: a.shift.crossesMidnight,
      exception: preview.exception,
      stored: punch,
    });
    const checkInAt = asDate(punch?.checkInAt);
    const checkOutAt = asDate(punch?.checkOutAt);
    const day = evaluateAssignmentDay({
      assignmentStatus: a.status,
      workDate: a.workDate,
      employeeId: a.employeeId || '',
      now,
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      gracePeriodMinutes: a.shift.gracePeriodMinutes,
      hasCheckIn: !!checkInAt,
      exceptions,
    });

    if (a.status === 'OFF' && !day.exception) {
      rows.push(
        excusedDashes(identity, {
          shift: 'OFF',
          scheduledStart: '—',
          scheduledEnd: '—',
          status: 'OFF',
          flags: 'OFF',
        })
      );
      continue;
    }

    if (day.excused && !day.holidayWork && !checkInAt) {
      rows.push(
        excusedDashes(identity, {
          shift: a.status === 'OFF' ? 'OFF' : exportShiftName(a.shift),
          scheduledStart: a.status === 'OFF' ? '—' : formatTime(window.scheduledStart),
          scheduledEnd: a.status === 'OFF' ? '—' : formatTime(window.scheduledEnd),
          status: day.status,
          flags: day.status,
        })
      );
      continue;
    }

    const base = {
      ...identity,
      shift: a.status === 'OFF' && !checkInAt ? 'OFF' : exportShiftName(a.shift),
      scheduledStart: a.status === 'OFF' && !checkInAt ? '—' : formatTime(window.scheduledStart),
      scheduledEnd: a.status === 'OFF' && !checkInAt ? '—' : formatTime(window.scheduledEnd),
    };

    if (checkInAt && punch) {
      const display = resolveAttendanceDisplay({
        now,
        punch: {
          checkInAt,
          checkOutAt,
          workedMinutes: punch.workedMinutes,
          lateMinutes: punch.lateMinutes,
          overtimeMinutes: punch.overtimeMinutes,
          earlyLeaveMinutes: punch.earlyLeaveMinutes,
          statusPrimary: punch.statusPrimary,
          flags: punch.flags,
        },
        scheduledEnd: window.scheduledEnd,
        checkoutWindowAfterMinutes: a.shift.checkoutWindowAfterMinutes,
        holidayWork: day.holidayWork,
        dayStatus: day.status,
        excused: day.excused,
        exceptionType: day.exception?.type,
      });
      const stale = isStaleMissingCheckout(
        {
          checkInAt,
          checkOutAt,
          scheduledEnd: window.scheduledEnd,
          checkoutWindowAfterMinutes: a.shift.checkoutWindowAfterMinutes,
        },
        now
      );
      rows.push({
        ...base,
        checkIn: formatTime(checkInAt),
        checkOut: checkOutAt && !stale ? formatTime(checkOutAt) : '—',
        worked: display.workedMinutes == null ? '—' : formatDuration(display.workedMinutes),
        late: String(display.lateMinutes),
        earlyLeave: !checkOutAt || stale ? '—' : String(display.earlyLeaveMinutes ?? 0),
        ot: !checkOutAt || stale ? '—' : String(display.overtimeMinutes ?? 0),
        status: display.status,
        flags: display.flags.join('|'),
        workedMinutes: display.workedMinutes,
        lateMinutes: display.lateMinutes,
        earlyLeaveMinutes: !checkOutAt || stale ? null : display.earlyLeaveMinutes,
        overtimeMinutes: !checkOutAt || stale ? null : display.overtimeMinutes,
        missingCheckout: stale || display.status === 'MISSING_CHECKOUT',
      });
      continue;
    }

    rows.push({
      ...base,
      checkIn: '—',
      checkOut: '—',
      worked: '—',
      late: '—',
      earlyLeave: '—',
      ot: '—',
      status: day.status,
      flags: day.status,
      ...emptyMetrics(),
    });
  }

  return rows.sort((a, b) => {
    if (a.workDate !== b.workDate) return a.workDate.localeCompare(b.workDate);
    if (a.employee !== b.employee) return a.employee.localeCompare(b.employee);
    return a.scheduledStart.localeCompare(b.scheduledStart);
  });
}

export function summarizeExportRows(rows: ExportRow[]): ExportSummaryRow[] {
  const groups = new Map<string, ExportSummaryRow>();
  for (const row of rows) {
    const key = row.employeeId || row.bn;
    const current = groups.get(key) || {
      employeeId: row.employeeId,
      employee: row.employee,
      bn: row.bn,
      totalWorkedMinutes: 0,
      totalLateMinutes: 0,
      totalShortMinutes: 0,
      totalOtMinutes: 0,
      lateDays: 0,
      missingCheckout: 0,
      totalWorked: '',
      totalOt: '',
    };
    if (row.workedMinutes != null) current.totalWorkedMinutes += row.workedMinutes;
    if (row.lateMinutes != null) {
      current.totalLateMinutes += row.lateMinutes;
      if (row.lateMinutes > 0) current.lateDays += 1;
    }
    if (row.earlyLeaveMinutes != null) current.totalShortMinutes += row.earlyLeaveMinutes;
    if (row.overtimeMinutes != null) current.totalOtMinutes += row.overtimeMinutes;
    if (row.missingCheckout) current.missingCheckout += 1;
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((row) => ({
      ...row,
      totalWorked: formatDuration(row.totalWorkedMinutes),
      totalOt: formatDuration(row.totalOtMinutes),
    }))
    .sort((a, b) => a.employee.localeCompare(b.employee) || a.bn.localeCompare(b.bn));
}

export function rowsToCsv(rows: ExportRow[]): string {
  const summaries = summarizeExportRows(rows);
  const lines = [
    'Detailed Attendance',
    EXPORT_COLUMNS.join(','),
    ...rows.map((r) =>
      [
        r.workDate,
        r.employee,
        r.bn,
        r.shift,
        r.project,
        r.scheduledStart,
        r.scheduledEnd,
        r.checkIn,
        r.checkOut,
        r.worked,
        r.late,
        r.earlyLeave,
        r.ot,
        r.status,
        r.flags,
      ]
        .map(csvEscape)
        .join(',')
    ),
    '',
    'Summary',
    EXPORT_SUMMARY_COLUMNS.join(','),
    ...summaries.map((row) =>
      [
        row.employee,
        row.bn,
        row.totalWorked,
        String(row.totalLateMinutes),
        String(row.totalShortMinutes),
        row.totalOt,
        String(row.lateDays),
        String(row.missingCheckout),
      ]
        .map(csvEscape)
        .join(',')
    ),
  ];
  return `\uFEFF${lines.join('\n')}`;
}

export function exportDownloadUrl(
  from: string,
  to: string,
  options?: { employeeId?: string | null; projectId?: string | null }
): string {
  const params = new URLSearchParams({ from, to });
  if (options?.employeeId) params.set('employeeId', options.employeeId);
  if (options?.projectId) params.set('projectId', options.projectId);
  return `/api/exports/attendance?${params.toString()}`;
}

export function validateExportForm(from: string, to: string): string | null {
  const parsed = parseExportRange({ from, to });
  return parsed.ok ? null : parsed.error;
}
