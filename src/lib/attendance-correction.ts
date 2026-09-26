import { AttendanceMethod } from '@prisma/client';
import { calculateAttendance, scheduledWindow } from './attendance-calc';
import { shiftForChoice, type ShiftCatalog, type ShiftChoice } from './shift-catalog';
import { fromAppWallTime } from './timezone';

export type CorrectionInput = {
  employeeId: string;
  workDate: string;
  choice?: Exclude<ShiftChoice, 'OFF'>;
  checkInAt: Date;
  checkOutAt: Date | null;
  reason: string;
};

export type CorrectionDecision =
  | { ok: false; error: string; status: number }
  | {
      ok: true;
      needsAssignment: boolean;
      choice: Exclude<ShiftChoice, 'OFF'>;
      existingAttendanceId: string | null;
    };

export function parseAppDateTime(workDate: string, value: string): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    const [date, time] = value.split('T');
    return fromAppWallTime(date, time);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function planAttendanceCorrection(input: {
  employeeId: string;
  workDate: string;
  choice?: string;
  reason: string;
  existingAssignment: { id: string; status: string; shiftId: string } | null;
  existingAttendance: { id: string; checkInAt: Date | null } | null;
  catalog: ShiftCatalog;
}): CorrectionDecision {
  if (!input.reason.trim()) return { ok: false, error: 'Reason is required', status: 400 };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workDate)) {
    return { ok: false, error: 'Invalid workDate', status: 400 };
  }
  if (input.existingAttendance?.checkInAt) {
    return {
      ok: false,
      error: 'Attendance already exists for this date. Use attendance adjustment workflow.',
      status: 409,
    };
  }
  if (input.existingAssignment && input.existingAssignment.status === 'SCHEDULED') {
    return {
      ok: true,
      needsAssignment: false,
      choice: (input.choice === 'SHIFT_2' ? 'SHIFT_2' : 'SHIFT_1') as 'SHIFT_1' | 'SHIFT_2',
      existingAttendanceId: input.existingAttendance?.id ?? null,
    };
  }
  const choice = input.choice === 'SHIFT_2' ? 'SHIFT_2' : input.choice === 'SHIFT_1' ? 'SHIFT_1' : null;
  if (!choice) {
    return { ok: false, error: 'Shift 1 or Shift 2 is required when no assignment exists', status: 400 };
  }
  if (!shiftForChoice(input.catalog, choice)) {
    return { ok: false, error: `${choice} is not configured`, status: 400 };
  }
  return {
    ok: true,
    needsAssignment: !input.existingAssignment || input.existingAssignment.status !== 'SCHEDULED',
    choice,
    existingAttendanceId: input.existingAttendance?.id ?? null,
  };
}

export function correctionCalc(input: {
  workDate: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  gracePeriodMinutes: number;
  checkInAt: Date;
  checkOutAt: Date | null;
}) {
  const window = scheduledWindow(input.workDate, input.startTime, input.endTime, input.crossesMidnight);
  return {
    window,
    calc: calculateAttendance({
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      checkInAt: input.checkInAt,
      checkOutAt: input.checkOutAt,
      gracePeriodMinutes: input.gracePeriodMinutes,
      manualCheckIn: true,
      manualCheckOut: !!input.checkOutAt,
    }),
    method: AttendanceMethod.MANUAL,
  };
}

export type CorrectionDb = {
  employee: { findUnique: (args?: any) => Promise<any> };
  project: { findFirst: (args?: any) => Promise<any> };
  employeeShiftAssignment: {
    findFirst: (args?: any) => Promise<any>;
    create: (args?: any) => Promise<any>;
    update: (args?: any) => Promise<any>;
  };
  attendanceRecord: {
    findFirst: (args?: any) => Promise<any>;
    create: (args?: any) => Promise<any>;
  };
  attendanceAdjustment: { create: (args?: any) => Promise<any> };
};

export async function applyAttendanceCorrection(input: {
  db: CorrectionDb;
  catalog: ShiftCatalog;
  actorId: string;
  employeeId: string;
  workDate: string;
  choice?: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  reason: string;
  writeAudit: (row: {
    actorId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    employeeId?: string;
    oldValue?: unknown;
    newValue?: unknown;
  }) => Promise<void>;
}) {
  const employee = await input.db.employee.findUnique({
    where: { id: input.employeeId },
    include: { defaultProject: true },
  });
  if (!employee) return { ok: false as const, error: 'Employee not found', status: 404 };

  const existingAssignment = await input.db.employeeShiftAssignment.findFirst({
    where: { employeeId: input.employeeId, workDate: input.workDate },
    include: { shift: true, attendance: { select: { id: true, checkInAt: true } } },
  });
  const existingAttendance =
    existingAssignment?.attendance?.find((row: { checkInAt: Date | null }) => row.checkInAt) ||
    (await input.db.attendanceRecord.findFirst({
      where: { employeeId: input.employeeId, assignment: { workDate: input.workDate } },
    }));

  const decision = planAttendanceCorrection({
    employeeId: input.employeeId,
    workDate: input.workDate,
    choice: input.choice,
    reason: input.reason,
    existingAssignment: existingAssignment
      ? { id: existingAssignment.id, status: existingAssignment.status, shiftId: existingAssignment.shiftId }
      : null,
    existingAttendance: existingAttendance
      ? { id: existingAttendance.id, checkInAt: existingAttendance.checkInAt }
      : null,
    catalog: input.catalog,
  });
  if (!decision.ok) return decision;

  const shift =
    existingAssignment?.status === 'SCHEDULED'
      ? existingAssignment.shift
      : shiftForChoice(input.catalog, decision.choice);
  if (!shift) return { ok: false as const, error: 'Shift is not configured', status: 400 };

  const projectId =
    existingAssignment?.projectId ||
    employee.defaultProjectId ||
    (await input.db.project.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } }))?.id;
  if (!projectId) return { ok: false as const, error: 'No project available for assignment', status: 400 };

  let assignment = existingAssignment;
  if (decision.needsAssignment) {
    if (assignment) {
      assignment = await input.db.employeeShiftAssignment.update({
        where: { id: assignment.id },
        data: { shiftId: shift.id, status: 'SCHEDULED', projectId },
        include: { shift: true },
      });
    } else {
      assignment = await input.db.employeeShiftAssignment.create({
        data: {
          employeeId: input.employeeId,
          projectId,
          shiftId: shift.id,
          workDate: input.workDate,
          status: 'SCHEDULED',
        },
        include: { shift: true },
      });
    }
  }

  const built = correctionCalc({
    workDate: input.workDate,
    startTime: shift.startTime,
    endTime: shift.endTime,
    crossesMidnight: shift.crossesMidnight,
    gracePeriodMinutes: shift.gracePeriodMinutes,
    checkInAt: input.checkInAt,
    checkOutAt: input.checkOutAt,
  });
  const flags: string[] = [...built.calc.flags];
  if (!flags.includes('PUNCHING_ISSUE')) flags.push('PUNCHING_ISSUE');

  const record = await input.db.attendanceRecord.create({
    data: {
      employeeId: input.employeeId,
      projectId,
      shiftId: shift.id,
      assignmentId: assignment.id,
      scheduledStart: built.window.scheduledStart,
      scheduledEnd: built.window.scheduledEnd,
      checkInAt: input.checkInAt,
      checkOutAt: input.checkOutAt,
      checkInMethod: AttendanceMethod.MANUAL,
      checkOutMethod: input.checkOutAt ? AttendanceMethod.MANUAL : null,
      workedMinutes: built.calc.workedMinutes,
      lateMinutes: built.calc.lateMinutes,
      earlyLeaveMinutes: built.calc.earlyLeaveMinutes,
      overtimeMinutes: built.calc.overtimeMinutes,
      flags: JSON.stringify(flags),
      statusPrimary: built.calc.statusPrimary,
      manualOverride: true,
    },
  });

  await input.db.attendanceAdjustment.create({
    data: {
      attendanceId: record.id,
      field: 'attendance',
      oldValue: null,
      newValue: JSON.stringify({
        checkInAt: input.checkInAt.toISOString(),
        checkOutAt: input.checkOutAt?.toISOString() ?? null,
        workDate: input.workDate,
        shiftId: shift.id,
      }),
      reason: input.reason.trim(),
      changedById: input.actorId,
    },
  });

  await input.writeAudit({
    actorId: input.actorId,
    action: 'ATTENDANCE_CORRECTED',
    entityType: 'AttendanceRecord',
    entityId: record.id,
    employeeId: input.employeeId,
    oldValue: existingAssignment
      ? { assignmentId: existingAssignment.id, status: existingAssignment.status, attendanceId: null }
      : null,
    newValue: {
      workDate: input.workDate,
      reason: input.reason.trim(),
      checkInAt: input.checkInAt.toISOString(),
      checkOutAt: input.checkOutAt?.toISOString() ?? null,
      assignmentId: assignment.id,
      attendanceId: record.id,
    },
  });

  return { ok: true as const, record, assignment, calc: built.calc };
}
