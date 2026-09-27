import { AttendanceMethod } from '@prisma/client';
import { calculateAttendance, scheduledWindow } from './attendance-calc';
import { shiftForChoice, type ShiftCatalog, type ShiftChoice } from './shift-catalog';
import { fromAppWallTime } from './timezone';

export type CorrectionInput = {
  employeeId: string;
  workDate: string;
  choice?: Exclude<ShiftChoice, 'OFF'>;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  reason: string;
};

export type CorrectionDecision =
  | { ok: false; error: string; status: number }
  | {
      ok: true;
      mode: 'create' | 'missing_out';
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

function plannedChoice(
  choice: string | undefined,
  fallback: 'SHIFT_1' | 'SHIFT_2' = 'SHIFT_1'
): 'SHIFT_1' | 'SHIFT_2' {
  return choice === 'SHIFT_2' ? 'SHIFT_2' : fallback;
}

export function planAttendanceCorrection(input: {
  employeeId: string;
  workDate: string;
  choice?: string;
  reason: string;
  existingAssignment: { id: string; status: string; shiftId: string } | null;
  existingAttendance: { id: string; checkInAt: Date | null; checkOutAt?: Date | null } | null;
  catalog: ShiftCatalog;
}): CorrectionDecision {
  if (!input.reason.trim()) return { ok: false, error: 'Reason is required', status: 400 };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workDate)) {
    return { ok: false, error: 'Invalid workDate', status: 400 };
  }

  if (input.existingAttendance?.checkInAt && input.existingAttendance.checkOutAt) {
    return {
      ok: false,
      error: 'Attendance already has a checkout. This workflow cannot overwrite it.',
      status: 409,
    };
  }

  if (input.existingAttendance?.checkInAt && !input.existingAttendance.checkOutAt) {
    return {
      ok: true,
      mode: 'missing_out',
      needsAssignment: false,
      choice: plannedChoice(input.choice),
      existingAttendanceId: input.existingAttendance.id,
    };
  }

  if (input.existingAssignment && input.existingAssignment.status === 'SCHEDULED') {
    return {
      ok: true,
      mode: 'create',
      needsAssignment: false,
      choice: plannedChoice(input.choice),
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
    mode: 'create',
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
  manualCheckIn?: boolean;
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
      manualCheckIn: input.manualCheckIn ?? true,
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
    findUnique?: (args?: any) => Promise<any>;
    create: (args?: any) => Promise<any>;
    update?: (args?: any) => Promise<any>;
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
  attendanceId?: string;
  checkInAt: Date | null;
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
    include: { shift: true, attendance: true },
  });

  let existingAttendance =
    (input.attendanceId && input.db.attendanceRecord.findUnique
      ? await input.db.attendanceRecord.findUnique({ where: { id: input.attendanceId } })
      : null) ||
    existingAssignment?.attendance?.find((row: { checkInAt: Date | null }) => row.checkInAt) ||
    (await input.db.attendanceRecord.findFirst({
      where: { employeeId: input.employeeId, assignment: { workDate: input.workDate } },
    }));

  if (input.attendanceId && existingAttendance && existingAttendance.id !== input.attendanceId) {
    existingAttendance = input.db.attendanceRecord.findUnique
      ? await input.db.attendanceRecord.findUnique({ where: { id: input.attendanceId } })
      : existingAttendance;
  }
  if (existingAttendance && existingAttendance.employeeId && existingAttendance.employeeId !== input.employeeId) {
    return { ok: false as const, error: 'Attendance does not belong to this employee', status: 404 };
  }

  const decision = planAttendanceCorrection({
    employeeId: input.employeeId,
    workDate: input.workDate,
    choice: input.choice,
    reason: input.reason,
    existingAssignment: existingAssignment
      ? { id: existingAssignment.id, status: existingAssignment.status, shiftId: existingAssignment.shiftId }
      : null,
    existingAttendance: existingAttendance
      ? {
          id: existingAttendance.id,
          checkInAt: existingAttendance.checkInAt,
          checkOutAt: existingAttendance.checkOutAt ?? null,
        }
      : null,
    catalog: input.catalog,
  });
  if (!decision.ok) return decision;

  if (decision.mode === 'missing_out') {
    if (!input.checkOutAt) {
      return { ok: false as const, error: 'Actual check-out is required', status: 400 };
    }
    if (!existingAttendance?.checkInAt) {
      return { ok: false as const, error: 'Missing checkout record not found', status: 404 };
    }
    if (existingAttendance.checkOutAt) {
      return {
        ok: false as const,
        error: 'Attendance already has a checkout. This workflow cannot overwrite it.',
        status: 409,
      };
    }
    if (!input.db.attendanceRecord.update) {
      return { ok: false as const, error: 'Correction update is unavailable', status: 500 };
    }

    const shift = existingAssignment?.shift || existingAttendance.shift;
    const grace = shift?.gracePeriodMinutes ?? 5;
    const scheduledStart = existingAttendance.scheduledStart;
    const scheduledEnd = existingAttendance.scheduledEnd;
    const originalCheckIn = existingAttendance.checkInAt;
    const calc = calculateAttendance({
      scheduledStart,
      scheduledEnd,
      checkInAt: originalCheckIn,
      checkOutAt: input.checkOutAt,
      gracePeriodMinutes: grace,
      manualCheckIn: existingAttendance.checkInMethod === AttendanceMethod.MANUAL,
      manualCheckOut: true,
    });
    const flags: string[] = [...calc.flags];
    if (!flags.includes('PUNCHING_ISSUE')) flags.push('PUNCHING_ISSUE');

    const oldValue = {
      checkInAt: originalCheckIn.toISOString(),
      checkOutAt: null,
      workedMinutes: existingAttendance.workedMinutes ?? null,
      overtimeMinutes: existingAttendance.overtimeMinutes ?? null,
      earlyLeaveMinutes: existingAttendance.earlyLeaveMinutes ?? null,
      statusPrimary: existingAttendance.statusPrimary,
    };

    const record = await input.db.attendanceRecord.update({
      where: { id: existingAttendance.id },
      data: {
        checkOutAt: input.checkOutAt,
        checkOutMethod: AttendanceMethod.MANUAL,
        workedMinutes: calc.workedMinutes,
        lateMinutes: calc.lateMinutes,
        earlyLeaveMinutes: calc.earlyLeaveMinutes,
        overtimeMinutes: calc.overtimeMinutes,
        flags: JSON.stringify(flags),
        statusPrimary: calc.statusPrimary,
        manualOverride: true,
      },
    });

    await input.db.attendanceAdjustment.create({
      data: {
        attendanceId: existingAttendance.id,
        field: 'checkOutAt',
        oldValue: null,
        newValue: JSON.stringify({
          checkInAt: originalCheckIn.toISOString(),
          checkOutAt: input.checkOutAt.toISOString(),
          workDate: input.workDate,
        }),
        reason: input.reason.trim(),
        changedById: input.actorId,
      },
    });

    await input.writeAudit({
      actorId: input.actorId,
      action: 'ATTENDANCE_CORRECTED',
      entityType: 'AttendanceRecord',
      entityId: existingAttendance.id,
      employeeId: input.employeeId,
      oldValue,
      newValue: {
        workDate: input.workDate,
        reason: input.reason.trim(),
        checkInAt: originalCheckIn.toISOString(),
        checkOutAt: input.checkOutAt.toISOString(),
        attendanceId: existingAttendance.id,
        workedMinutes: calc.workedMinutes,
        overtimeMinutes: calc.overtimeMinutes,
        earlyLeaveMinutes: calc.earlyLeaveMinutes,
        statusPrimary: calc.statusPrimary,
      },
    });

    return { ok: true as const, record, assignment: existingAssignment, calc };
  }

  if (!input.checkInAt) return { ok: false as const, error: 'Valid check-in is required', status: 400 };

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
