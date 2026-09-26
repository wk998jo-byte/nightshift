import { DateTime } from 'luxon';
import { formatDuration, formatTime, scheduledWindow } from './attendance-calc';
import { isDemoEmployeeCode, isDemoEmployeeName } from './demo-employee';
import { classifyShift } from './shift-catalog';
import { addCalendarDays, getAppTimezone } from './timezone';
import {
  evaluateAssignmentDay,
  halfDayWindow,
  type DayExceptionRecord,
} from './day-status';

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
  'Early Leave (min)',
  'OT (min)',
  'Status',
  'Flags',
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
  };
  attendance: Array<{
    checkInAt: Date | string | null;
    checkOutAt: Date | string | null;
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

export function exportFilename(from: string, to: string): string {
  if (from === to) return `attendance-${from}.csv`;
  return `attendance-${from}-to-${to}.csv`;
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

function parseFlags(raw: string | null | undefined): string {
  try {
    const flags = JSON.parse(raw || '[]');
    return Array.isArray(flags) ? flags.join('|') : '';
  } catch {
    return '';
  }
}

function excusedDashes(identity: {
  workDate: string;
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
  };
}

export function buildExportRows(
  assignments: ExportAssignment[],
  now = new Date(),
  exceptions: DayExceptionRecord[] = []
): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const a of assignments) {
    if (a.status !== 'SCHEDULED' && a.status !== 'OFF') continue;
    if (!includeExportEmployee(a.employee)) continue;

    const identity = {
      workDate: a.workDate,
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
    if (preview.exception?.type === 'HALF_DAY') {
      window = halfDayWindow(
        a.workDate,
        preview.exception,
        a.shift.startTime,
        a.shift.endTime,
        a.shift.crossesMidnight
      );
    }

    const punch = a.attendance.find((r) => r.checkInAt) ?? null;
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
      const ot = day.holidayWork && punch.workedMinutes != null ? punch.workedMinutes : punch.overtimeMinutes;
      const status = day.holidayWork ? 'HOLIDAY_WORK' : day.exception && day.excused ? day.status : punch.statusPrimary;
      const flags = [parseFlags(punch.flags), day.holidayWork ? 'HOLIDAY_WORK' : '', day.exception && day.excused && !day.holidayWork ? day.status : '']
        .filter(Boolean)
        .join('|');
      rows.push({
        ...base,
        checkIn: formatTime(checkInAt),
        checkOut: formatTime(checkOutAt),
        worked: formatDuration(punch.workedMinutes),
        late: String(punch.lateMinutes),
        earlyLeave: String(punch.earlyLeaveMinutes),
        ot: String(ot),
        status,
        flags,
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
    });
  }

  return rows.sort((a, b) => {
    if (a.workDate !== b.workDate) return a.workDate.localeCompare(b.workDate);
    if (a.employee !== b.employee) return a.employee.localeCompare(b.employee);
    return a.scheduledStart.localeCompare(b.scheduledStart);
  });
}

export function rowsToCsv(rows: ExportRow[]): string {
  const lines = [
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
  ];
  return `\uFEFF${lines.join('\n')}`;
}

export function exportDownloadUrl(from: string, to: string): string {
  return `/api/exports/attendance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

export function validateExportForm(from: string, to: string): string | null {
  const parsed = parseExportRange({ from, to });
  return parsed.ok ? null : parsed.error;
}
