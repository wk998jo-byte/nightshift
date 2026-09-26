import { AssignmentStatus } from '@prisma/client';
import { catalogFromShifts, shiftForChoice, type ShiftCatalog } from './shift-catalog';
import { choiceForAssignment } from './shift-catalog';
import {
  OFFICIAL_PROJECT_CODE,
  type OfficialChoice,
  type RosterCsvRow,
} from './roster-official';
import { choiceTotals, parseRosterCsv, validateOfficialRoster } from './roster-csv';

export type RosterImportDb = {
  employee: { findMany: (args?: any) => Promise<any[]> };
  project: { findUnique: (args?: any) => Promise<any> };
  shift: { findMany: (args?: any) => Promise<any[]> };
  employeeShiftAssignment: {
    findMany: (args?: any) => Promise<any[]>;
    create: (args?: any) => Promise<any>;
    update: (args?: any) => Promise<any>;
  };
  attendanceRecord: { findFirst: (args?: any) => Promise<any> };
  $transaction?: (fn: (tx: RosterImportDb) => Promise<unknown>) => Promise<unknown>;
};

export type PlannedRosterAction = {
  employeeCode: string;
  employeeId: string;
  workDate: string;
  choice: OfficialChoice;
  action: 'create' | 'update' | 'unchanged' | 'locked';
};

export type RosterPlan = {
  ok: boolean;
  errors: string[];
  created: PlannedRosterAction[];
  updated: PlannedRosterAction[];
  unchanged: PlannedRosterAction[];
  locked: PlannedRosterAction[];
  dateRange: { from: string; to: string } | null;
  totals: Record<string, { SHIFT_1: number; SHIFT_2: number; OFF: number }>;
  rowCount: number;
  dateCount: number;
};

function hasCheckIn(assignment: { attendance?: Array<{ checkInAt: Date | null }> } | null): boolean {
  return !!assignment?.attendance?.some((row) => row.checkInAt);
}

export function buildRosterPlan(input: {
  rows: RosterCsvRow[];
  parseErrors: string[];
  employees: Array<{ id: string; employeeCode: string }>;
  projectId: string | null;
  catalog: ShiftCatalog;
  existing: Array<{
    id: string;
    employeeId: string;
    workDate: string;
    shiftId: string;
    status: string;
    shift?: { id: string; startTime: string; endTime: string };
    attendance?: Array<{ checkInAt: Date | null }>;
  }>;
}): RosterPlan {
  const errors = [...input.parseErrors];
  const validation = validateOfficialRoster(input.rows);
  errors.push(...validation);
  if (!input.projectId) errors.push(`Project ${OFFICIAL_PROJECT_CODE} not found`);
  if (!input.catalog.shift1 || !input.catalog.shift2) errors.push('Production Shift 1 / Shift 2 not configured');

  const byCode = new Map(input.employees.map((e) => [e.employeeCode, e]));
  const existingByKey = new Map(input.existing.map((a) => [`${a.employeeId}:${a.workDate}`, a]));
  const created: PlannedRosterAction[] = [];
  const updated: PlannedRosterAction[] = [];
  const unchanged: PlannedRosterAction[] = [];
  const locked: PlannedRosterAction[] = [];

  for (const row of input.rows) {
    const employee = byCode.get(row.employeeCode);
    if (!employee) {
      errors.push(`Employee ${row.employeeCode} not in database`);
      continue;
    }
    const existing = existingByKey.get(`${employee.id}:${row.workDate}`) ?? null;
    const targetShiftId =
      row.choice === 'OFF'
        ? input.catalog.shift1?.id
        : shiftForChoice(input.catalog, row.choice)?.id;
    const targetStatus = row.choice === 'OFF' ? 'OFF' : 'SCHEDULED';
    const actionBase = {
      employeeCode: row.employeeCode,
      employeeId: employee.id,
      workDate: row.workDate,
      choice: row.choice,
    };
    if (!existing) {
      created.push({ ...actionBase, action: 'create' });
      continue;
    }
    const currentChoice = choiceForAssignment(
      existing.shift || { id: existing.shiftId, startTime: '', endTime: '' },
      existing.status,
      input.catalog
    );
    if (currentChoice === row.choice) {
      unchanged.push({ ...actionBase, action: 'unchanged' });
      continue;
    }
    if (hasCheckIn(existing)) {
      locked.push({ ...actionBase, action: 'locked' });
      continue;
    }
    updated.push({ ...actionBase, action: 'update' });
  }

  const dates = [...new Set(input.rows.map((r) => r.workDate))].sort();
  return {
    ok: errors.length === 0,
    errors,
    created,
    updated,
    unchanged,
    locked,
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    totals: choiceTotals(input.rows),
    rowCount: input.rows.length,
    dateCount: dates.length,
  };
}

export async function loadRosterContext(db: RosterImportDb, rows: RosterCsvRow[]) {
  const [employees, project, shifts] = await Promise.all([
    db.employee.findMany({
      where: { employeeCode: { in: [...new Set(rows.map((r) => r.employeeCode))] } },
      select: { id: true, employeeCode: true, defaultProjectId: true },
    }),
    db.project.findUnique({ where: { code: OFFICIAL_PROJECT_CODE } }),
    db.shift.findMany({ where: { isActive: true } }),
  ]);
  const catalog = catalogFromShifts(shifts);
  const employeeIds = employees.map((e) => e.id);
  const dates = [...new Set(rows.map((r) => r.workDate))];
  const existing = employeeIds.length
    ? await db.employeeShiftAssignment.findMany({
        where: { employeeId: { in: employeeIds }, workDate: { in: dates } },
        include: { shift: true, attendance: { select: { checkInAt: true } } },
      })
    : [];
  return { employees, project, catalog, existing };
}

export async function planOfficialRoster(db: RosterImportDb, csvText: string): Promise<RosterPlan> {
  const parsed = parseRosterCsv(csvText);
  const ctx = await loadRosterContext(db, parsed.rows);
  return buildRosterPlan({
    rows: parsed.rows,
    parseErrors: parsed.errors,
    employees: ctx.employees,
    projectId: ctx.project?.id ?? null,
    catalog: ctx.catalog,
    existing: ctx.existing,
  });
}

export async function applyOfficialRoster(
  db: RosterImportDb,
  csvText: string,
  writeAudit?: (input: {
    action: string;
    entityType?: string;
    newValue?: unknown;
  }) => Promise<void>
): Promise<RosterPlan> {
  const parsed = parseRosterCsv(csvText);
  const ctx = await loadRosterContext(db, parsed.rows);
  const plan = buildRosterPlan({
    rows: parsed.rows,
    parseErrors: parsed.errors,
    employees: ctx.employees,
    projectId: ctx.project?.id ?? null,
    catalog: ctx.catalog,
    existing: ctx.existing,
  });
  if (!plan.ok || !ctx.project || !ctx.catalog.shift1 || !ctx.catalog.shift2) return plan;

  const byCode = new Map(ctx.employees.map((e) => [e.employeeCode, e]));
  const existingByKey = new Map(ctx.existing.map((a) => [`${a.employeeId}:${a.workDate}`, a]));

  const applyOne = async (tx: RosterImportDb, row: RosterCsvRow, action: PlannedRosterAction) => {
    const employee = byCode.get(row.employeeCode)!;
    const shiftId = row.choice === 'OFF' ? ctx.catalog.shift1!.id : shiftForChoice(ctx.catalog, row.choice)!.id;
    const status = row.choice === 'OFF' ? AssignmentStatus.OFF : AssignmentStatus.SCHEDULED;
    const projectId = ctx.project!.id;
    if (action.action === 'create') {
      await tx.employeeShiftAssignment.create({
        data: { employeeId: employee.id, projectId, shiftId, workDate: row.workDate, status },
      });
      return;
    }
    if (action.action === 'update') {
      const existing = existingByKey.get(`${employee.id}:${row.workDate}`);
      if (!existing) return;
      await tx.employeeShiftAssignment.update({
        where: { id: existing.id },
        data: { shiftId, status, projectId },
      });
    }
  };

  const writes = [...plan.created, ...plan.updated];
  if (db.$transaction) {
    await db.$transaction(async (tx) => {
      for (const action of writes) {
        const row = parsed.rows.find(
          (r) => r.employeeCode === action.employeeCode && r.workDate === action.workDate
        )!;
        await applyOne(tx, row, action);
      }
    });
  } else {
    for (const action of writes) {
      const row = parsed.rows.find(
        (r) => r.employeeCode === action.employeeCode && r.workDate === action.workDate
      )!;
      await applyOne(db, row, action);
    }
  }

  if (writeAudit) {
    await writeAudit({
      action: 'ROSTER_IMPORTED',
      entityType: 'EmployeeShiftAssignment',
      newValue: {
        from: plan.dateRange?.from,
        to: plan.dateRange?.to,
        created: plan.created.length,
        updated: plan.updated.length,
        unchanged: plan.unchanged.length,
        locked: plan.locked.length,
      },
    });
  }
  return plan;
}

export function summarizePlan(plan: RosterPlan) {
  return {
    ok: plan.ok,
    errors: plan.errors,
    created: plan.created.length,
    updated: plan.updated.length,
    unchanged: plan.unchanged.length,
    locked: plan.locked.length,
    dateRange: plan.dateRange,
    totals: plan.totals,
    rowCount: plan.rowCount,
    dateCount: plan.dateCount,
  };
}
