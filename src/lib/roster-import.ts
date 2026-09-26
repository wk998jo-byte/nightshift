import { AssignmentStatus, Prisma } from '@prisma/client';
import { catalogFromShifts, shiftForChoice, type ShiftCatalog } from './shift-catalog';
import { choiceForAssignment } from './shift-catalog';
import {
  OFFICIAL_PROJECT_CODE,
  OFFICIAL_ROSTER_END,
  OFFICIAL_ROSTER_START,
  type OfficialChoice,
  type RosterCsvRow,
} from './roster-official';
import { choiceTotals, parseRosterCsv, validateOfficialRoster } from './roster-csv';

export type ExistingAssignment = {
  id: string;
  employeeId: string;
  workDate: string;
  shiftId: string;
  status: string;
  shift?: { id: string; startTime: string; endTime: string };
  attendance?: Array<{ checkInAt: Date | null }>;
};

export type RosterImportDb = {
  employee: { findMany: (args?: any) => Promise<any[]> };
  project: { findUnique: (args?: any) => Promise<any> };
  shift: { findMany: (args?: any) => Promise<any[]> };
  employeeShiftAssignment: {
    findMany: (args?: any) => Promise<any[]>;
    create?: (args?: any) => Promise<any>;
    createMany: (args?: any) => Promise<any>;
    update?: (args?: any) => Promise<any>;
    updateMany: (args?: any) => Promise<any>;
  };
  attendanceRecord: { findFirst: (args?: any) => Promise<any> };
  $transaction?: (
    fn: (tx: RosterImportDb) => Promise<unknown>,
    options?: RosterImportTransactionOptions
  ) => Promise<unknown>;
};

export type RosterImportTransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

export const ROSTER_IMPORT_TX_OPTIONS: RosterImportTransactionOptions = {
  maxWait: 10000,
  timeout: 120000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
};

export class RosterImportConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterImportConflict';
  }
}

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

export function employeeDateKey(employeeId: string, workDate: string): string {
  return `${employeeId}\t${workDate}`;
}

export function duplicateAssignmentErrors(
  existing: Array<Pick<ExistingAssignment, 'id' | 'employeeId' | 'workDate'>>,
  employees: Array<{ id: string; employeeCode: string }>
): string[] {
  const grouped = new Map<string, typeof existing>();
  for (const row of existing) {
    const key = employeeDateKey(row.employeeId, row.workDate);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  const codeById = new Map(employees.map((e) => [e.id, e.employeeCode]));
  const errors: string[] = [];
  for (const list of grouped.values()) {
    if (list.length <= 1) continue;
    const code = codeById.get(list[0].employeeId) || list[0].employeeId;
    errors.push(
      `Duplicate assignments already exist for employee ${code} on ${list[0].workDate} (${list.length} rows, ids ${list.map((r) => r.id).join(', ')}). Import refuses to guess which is authoritative.`
    );
  }
  return errors;
}

function groupExistingByEmployeeDate(existing: ExistingAssignment[]): Map<string, ExistingAssignment[]> {
  const grouped = new Map<string, ExistingAssignment[]>();
  for (const row of existing) {
    const key = employeeDateKey(row.employeeId, row.workDate);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return grouped;
}

function uniqueExistingByEmployeeDate(existing: ExistingAssignment[]): Map<string, ExistingAssignment> {
  const unique = new Map<string, ExistingAssignment>();
  for (const [key, list] of groupExistingByEmployeeDate(existing)) {
    if (list.length === 1) unique.set(key, list[0]);
  }
  return unique;
}

export function buildRosterPlan(input: {
  rows: RosterCsvRow[];
  parseErrors: string[];
  employees: Array<{ id: string; employeeCode: string }>;
  projectId: string | null;
  catalog: ShiftCatalog;
  existing: ExistingAssignment[];
}): RosterPlan {
  const errors = [...input.parseErrors];
  const validation = validateOfficialRoster(input.rows);
  errors.push(...validation);
  if (!input.projectId) errors.push(`Project ${OFFICIAL_PROJECT_CODE} not found`);
  if (!input.catalog.shift1 || !input.catalog.shift2) errors.push('Production Shift 1 / Shift 2 not configured');
  errors.push(...duplicateAssignmentErrors(input.existing, input.employees));

  const byCode = new Map(input.employees.map((e) => [e.employeeCode, e]));
  const groupedExisting = groupExistingByEmployeeDate(input.existing);
  const existingByKey = uniqueExistingByEmployeeDate(input.existing);
  const duplicateKeys = new Set(
    [...groupedExisting.entries()].filter(([, list]) => list.length > 1).map(([key]) => key)
  );
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
    if (duplicateKeys.has(employeeDateKey(employee.id, row.workDate))) {
      continue;
    }
    const existing = existingByKey.get(employeeDateKey(employee.id, row.workDate)) ?? null;
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
  const existing = await loadLiveAssignments(db, employeeIds);
  return { employees, project, catalog, existing };
}

export async function loadLiveAssignments(db: RosterImportDb, employeeIds: string[]) {
  if (!employeeIds.length) return [];
  return db.employeeShiftAssignment.findMany({
    where: {
      employeeId: { in: employeeIds },
      workDate: { gte: OFFICIAL_ROSTER_START, lte: OFFICIAL_ROSTER_END },
    },
    include: { shift: true, attendance: { select: { checkInAt: true } } },
  });
}

function assignmentWrite(input: {
  employeeId: string;
  workDate: string;
  choice: OfficialChoice;
  projectId: string;
  catalog: ShiftCatalog;
}) {
  const shiftId =
    input.choice === 'OFF' ? input.catalog.shift1!.id : shiftForChoice(input.catalog, input.choice)!.id;
  return {
    employeeId: input.employeeId,
    projectId: input.projectId,
    shiftId,
    workDate: input.workDate,
    status: input.choice === 'OFF' ? AssignmentStatus.OFF : AssignmentStatus.SCHEDULED,
  };
}

function isPrismaConflict(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
  return code === 'P2034' || code === 'P2028';
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

  const employeeIds = ctx.employees.map((e) => e.id);
  const projectId = ctx.project.id;
  let result: RosterPlan = plan;

  const applyBatched = async (tx: RosterImportDb) => {
    const live = await loadLiveAssignments(tx, employeeIds);
    const livePlan = buildRosterPlan({
      rows: parsed.rows,
      parseErrors: parsed.errors,
      employees: ctx.employees,
      projectId,
      catalog: ctx.catalog,
      existing: live,
    });
    if (!livePlan.ok) {
      throw new RosterImportConflict(livePlan.errors[0] || 'Live roster state is not safe to import');
    }

    const existingByKey = uniqueExistingByEmployeeDate(live);
    if (livePlan.created.length) {
      await tx.employeeShiftAssignment.createMany({
        data: livePlan.created.map((action) =>
          assignmentWrite({
            employeeId: action.employeeId,
            workDate: action.workDate,
            choice: action.choice,
            projectId,
            catalog: ctx.catalog,
          })
        ),
      });
    }

    const updateGroups = new Map<string, { ids: string[]; shiftId: string; status: AssignmentStatus }>();
    for (const action of livePlan.updated) {
      const existing = existingByKey.get(employeeDateKey(action.employeeId, action.workDate));
      if (!existing) continue;
      const data = assignmentWrite({
        employeeId: action.employeeId,
        workDate: action.workDate,
        choice: action.choice,
        projectId,
        catalog: ctx.catalog,
      });
      const key = `${data.shiftId}:${data.status}`;
      const group = updateGroups.get(key) ?? { ids: [], shiftId: data.shiftId, status: data.status };
      group.ids.push(existing.id);
      updateGroups.set(key, group);
    }
    for (const group of updateGroups.values()) {
      await tx.employeeShiftAssignment.updateMany({
        where: { id: { in: group.ids } },
        data: { shiftId: group.shiftId, status: group.status, projectId },
      });
    }

    result = livePlan;
  };

  try {
    if (db.$transaction) {
      await db.$transaction(applyBatched, ROSTER_IMPORT_TX_OPTIONS);
    } else {
      await applyBatched(db);
    }
  } catch (err) {
    if (err instanceof RosterImportConflict) {
      return {
        ...plan,
        ok: false,
        errors: [...plan.errors, err.message],
        created: [],
        updated: [],
      };
    }
    if (isPrismaConflict(err)) {
      return {
        ...plan,
        ok: false,
        errors: [...plan.errors, 'Roster import transaction conflict. No partial writes were kept. Retry the entire import.'],
        created: [],
        updated: [],
      };
    }
    throw err;
  }

  if (writeAudit) {
    await writeAudit({
      action: 'ROSTER_IMPORTED',
      entityType: 'EmployeeShiftAssignment',
      newValue: {
        from: result.dateRange?.from,
        to: result.dateRange?.to,
        created: result.created.length,
        updated: result.updated.length,
        unchanged: result.unchanged.length,
        locked: result.locked.length,
      },
    });
  }
  return result;
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
