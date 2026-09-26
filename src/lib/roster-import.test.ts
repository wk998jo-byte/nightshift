import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseRosterCsv, validateOfficialRoster, choiceTotals } from './roster-csv';
import {
  OFFICIAL_CHOICE_TOTALS,
  OFFICIAL_EMPLOYEE_CODES,
  OFFICIAL_ROSTER_DATES,
  OFFICIAL_ROSTER_END,
  OFFICIAL_ROSTER_FILE,
  OFFICIAL_ROSTER_ROWS,
  OFFICIAL_ROSTER_START,
} from './roster-official';
import { buildRosterPlan, planOfficialRoster, summarizePlan } from './roster-import';
import { catalogFromShifts } from './shift-catalog';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

function officialCsv() {
  const candidates = [OFFICIAL_ROSTER_FILE, `${OFFICIAL_ROSTER_FILE}.csv`];
  const path = candidates.find((p) => existsSync(p));
  assert.ok(path, `Official roster CSV missing. Expected ${OFFICIAL_ROSTER_FILE}`);
  return readFileSync(path, 'utf8');
}

const shift1 = {
  id: 's1',
  name: 'Night Shift 1',
  startTime: '15:30',
  endTime: '03:30',
  crossesMidnight: true,
  gracePeriodMinutes: 5,
  isActive: true,
};
const shift2 = {
  id: 's2',
  name: 'Night Shift 2',
  startTime: '19:30',
  endTime: '07:30',
  crossesMidnight: true,
  gracePeriodMinutes: 5,
  isActive: true,
};

const employees = [
  { id: 'e-71326', employeeCode: '71326' },
  { id: 'e-71343', employeeCode: '71343' },
  { id: 'e-71378', employeeCode: '71378' },
];

function mockDb(existing: any[] = [], writes = { created: 0, updated: 0 }) {
  return {
    writes,
    employee: { findMany: async () => employees },
    project: { findUnique: async () => ({ id: 'p1', code: 'HQ-01' }) },
    shift: { findMany: async () => [shift1, shift2] },
    employeeShiftAssignment: {
      findMany: async () => existing,
      create: async () => {
        writes.created += 1;
        return { id: `c${writes.created}` };
      },
      update: async () => {
        writes.updated += 1;
        return { id: `u${writes.updated}` };
      },
    },
    attendanceRecord: { findFirst: async () => null },
  };
}

describe('official roster CSV', () => {
  it('has exactly 97 dates, 291 rows, three employees, and official totals', () => {
    const parsed = parseRosterCsv(officialCsv());
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows.length, OFFICIAL_ROSTER_ROWS);
    const dates = new Set(parsed.rows.map((r) => r.workDate));
    assert.equal(dates.size, OFFICIAL_ROSTER_DATES);
    assert.equal([...dates].sort()[0], OFFICIAL_ROSTER_START);
    assert.equal([...dates].sort().at(-1), OFFICIAL_ROSTER_END);
    assert.deepEqual([...new Set(parsed.rows.map((r) => r.employeeCode))].sort(), [...OFFICIAL_EMPLOYEE_CODES].sort());
    assert.deepEqual(validateOfficialRoster(parsed.rows), []);
    assert.deepEqual(choiceTotals(parsed.rows), OFFICIAL_CHOICE_TOTALS);
  });

  it('maps Shift 1 / Shift 2 / OFF times correctly', () => {
    const parsed = parseRosterCsv(officialCsv());
    const s1 = parsed.rows.find((r) => r.choice === 'SHIFT_1')!;
    const s2 = parsed.rows.find((r) => r.choice === 'SHIFT_2')!;
    const off = parsed.rows.find((r) => r.choice === 'OFF')!;
    assert.equal(s1.shiftStart, '15:30');
    assert.equal(s1.shiftEnd, '03:30');
    assert.equal(s2.shiftStart, '19:30');
    assert.equal(s2.shiftEnd, '07:30');
    assert.equal(off.shiftStart, '—');
    assert.equal(off.shiftEnd, '—');
  });

  it('rejects unknown employee, unknown choice, date outside range, and duplicates', () => {
    const bad = parseRosterCsv(
      [
        'Work Date,Employee Code,Employee Name,Choice,Shift Start,Shift End,Project Code',
        '2026-09-26,99999,Nobody,SHIFT_1,15:30,03:30,HQ-01',
        '2026-09-26,71326,Abdulaziz,NIGHT,15:30,03:30,HQ-01',
        '2026-09-25,71326,Abdulaziz,SHIFT_1,15:30,03:30,HQ-01',
        '2026-09-26,71326,Abdulaziz,SHIFT_1,15:30,03:30,HQ-01',
        '2026-09-26,71326,Abdulaziz,SHIFT_1,15:30,03:30,HQ-01',
      ].join('\n')
    );
    assert.ok(bad.errors.some((e) => /Unknown employee/.test(e)));
    assert.ok(bad.errors.some((e) => /Unknown choice/.test(e)));
    assert.ok(bad.errors.some((e) => /outside official range/.test(e)));
    assert.ok(bad.errors.some((e) => /Duplicate/.test(e)));
  });
});

describe('roster importer', () => {
  it('dry-run against the official CSV writes nothing and reports expected totals', async () => {
    const writes = { created: 0, updated: 0 };
    const db = mockDb([], writes);
    const plan = await planOfficialRoster(db, officialCsv());
    assert.equal(plan.ok, true);
    assert.equal(plan.rowCount, 291);
    assert.equal(plan.dateCount, 97);
    assert.equal(plan.created.length, 291);
    assert.equal(plan.updated.length, 0);
    assert.equal(plan.unchanged.length, 0);
    assert.equal(plan.locked.length, 0);
    assert.deepEqual(plan.dateRange, { from: '2026-09-26', to: '2026-12-31' });
    assert.deepEqual(plan.totals, OFFICIAL_CHOICE_TOTALS);
    assert.equal(writes.created, 0);
    assert.equal(writes.updated, 0);
    const summary = summarizePlan(plan);
    assert.equal(summary.created, 291);
    assert.equal(summary.errors.length, 0);
  });

  it('apply on empty DB creates all 291 official rows', async () => {
    const writes = { created: 0, updated: 0 };
    const db = mockDb([], writes);
    const { applyOfficialRoster } = await import('./roster-import');
    const plan = await applyOfficialRoster(db, officialCsv());
    assert.equal(plan.ok, true);
    assert.equal(writes.created, 291);
    assert.equal(writes.updated, 0);
  });

  it('creates missing assignments and is idempotent on rerun', async () => {
    const csv = [
      'Work Date,Employee Code,Employee Name,Choice,Shift Start,Shift End,Project Code',
      '2026-09-26,71326,Abdulaziz Abdullah H AlZahrani,SHIFT_2,19:30,07:30,HQ-01',
    ].join('\n');
    const rows = parseRosterCsv(csv).rows;
    const catalog = catalogFromShifts([shift1 as any, shift2 as any]);
    const plan = buildRosterPlan({
      rows,
      parseErrors: [],
      employees,
      projectId: 'p1',
      catalog,
      existing: [],
    });
    assert.equal(plan.created.length, 1);
    const existing = [
      {
        id: 'a1',
        employeeId: 'e-71326',
        workDate: '2026-09-26',
        shiftId: 's2',
        status: 'SCHEDULED',
        shift: shift2,
        attendance: [],
      },
    ];
    const again = buildRosterPlan({
      rows,
      parseErrors: [],
      employees,
      projectId: 'p1',
      catalog,
      existing,
    });
    assert.equal(again.created.length, 0);
    assert.equal(again.updated.length, 0);
    assert.equal(again.unchanged.length, 1);
    assert.equal(again.locked.length, 0);
  });

  it('updates a future assignment without attendance', () => {
    const rows = parseRosterCsv(
      [
        'Work Date,Employee Code,Employee Name,Choice,Shift Start,Shift End,Project Code',
        '2026-10-01,71343,Abdullah Mahmoud B AlAnazi,SHIFT_1,15:30,03:30,HQ-01',
      ].join('\n')
    ).rows;
    const plan = buildRosterPlan({
      rows,
      parseErrors: [],
      employees,
      projectId: 'p1',
      catalog: catalogFromShifts([shift1 as any, shift2 as any]),
      existing: [
        {
          id: 'old',
          employeeId: 'e-71343',
          workDate: '2026-10-01',
          shiftId: 's2',
          status: 'SCHEDULED',
          shift: shift2,
          attendance: [],
        },
      ],
    });
    assert.equal(plan.updated.length, 1);
    assert.equal(plan.locked.length, 0);
    assert.equal(plan.updated[0].choice, 'SHIFT_1');
  });

  it('does not overwrite an attendance-locked assignment', () => {
    const rows = parseRosterCsv(
      [
        'Work Date,Employee Code,Employee Name,Choice,Shift Start,Shift End,Project Code',
        '2026-09-26,71378,Turki Daher M AlShammari,OFF,—,—,HQ-01',
      ].join('\n')
    ).rows;
    const plan = buildRosterPlan({
      rows,
      parseErrors: [],
      employees,
      projectId: 'p1',
      catalog: catalogFromShifts([shift1 as any, shift2 as any]),
      existing: [
        {
          id: 'locked',
          employeeId: 'e-71378',
          workDate: '2026-09-26',
          shiftId: 's1',
          status: 'SCHEDULED',
          shift: shift1,
          attendance: [{ checkInAt: new Date('2026-09-26T12:40:00.000Z') }],
        },
      ],
    });
    assert.equal(plan.locked.length, 1);
    assert.equal(plan.updated.length, 0);
    assert.equal(plan.locked[0].employeeCode, '71378');
  });

  it('apply writes created rows and a second apply of the same plan is unchanged', async () => {
    const csv = [
      'Work Date,Employee Code,Employee Name,Choice,Shift Start,Shift End,Project Code',
      '2026-09-26,71326,Abdulaziz Abdullah H AlZahrani,SHIFT_1,15:30,03:30,HQ-01',
      '2026-09-26,71343,Abdullah Mahmoud B AlAnazi,SHIFT_2,19:30,07:30,HQ-01',
      '2026-09-26,71378,Turki Daher M AlShammari,OFF,—,—,HQ-01',
    ].join('\n');
    const parsed = parseRosterCsv(csv);
    const catalog = catalogFromShifts([shift1 as any, shift2 as any]);
    const firstPlan = buildRosterPlan({
      rows: parsed.rows,
      parseErrors: [],
      employees,
      projectId: 'p1',
      catalog,
      existing: [],
    });
    assert.equal(firstPlan.created.length, 3);
    const after = parsed.rows.map((row, i) => ({
      id: `a${i}`,
      employeeId: employees.find((e) => e.employeeCode === row.employeeCode)!.id,
      workDate: row.workDate,
      shiftId: row.choice === 'SHIFT_2' ? 's2' : 's1',
      status: row.choice === 'OFF' ? 'OFF' : 'SCHEDULED',
      shift: row.choice === 'SHIFT_2' ? shift2 : shift1,
      attendance: [],
    }));
    const second = buildRosterPlan({
      rows: parsed.rows,
      parseErrors: [],
      employees,
      projectId: 'p1',
      catalog,
      existing: after,
    });
    assert.equal(second.unchanged.length, 3);
    assert.equal(second.created.length, 0);
    assert.equal(second.updated.length, 0);
  });
});
