import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_EXPORT_DAYS,
  buildExportRows,
  canExportAttendance,
  countInclusiveDays,
  csvEscape,
  enumerateWorkDates,
  exportFilename,
  exportShiftName,
  includeExportEmployee,
  parseExportRange,
  rowsToCsv,
  type ExportAssignment,
} from './attendance-export';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

const shift1 = {
  name: 'Night Shift 1',
  startTime: '15:30',
  endTime: '03:30',
  crossesMidnight: true,
  gracePeriodMinutes: 5,
};
const shift2 = {
  name: 'Night Shift 2',
  startTime: '19:30',
  endTime: '07:30',
  crossesMidnight: true,
  gracePeriodMinutes: 5,
};

function person(
  name: string,
  code: string,
  opts: { active?: boolean; role?: string; userActive?: boolean } = {}
) {
  return {
    fullName: name,
    employeeCode: code,
    badgeNumber: code,
    isActive: opts.active ?? true,
    user: { role: opts.role || 'EMPLOYEE', isActive: opts.userActive ?? true },
  };
}

function asg(
  partial: Partial<ExportAssignment> & Pick<ExportAssignment, 'workDate' | 'employee' | 'shift'>
): ExportAssignment {
  return {
    status: 'SCHEDULED',
    project: { name: 'Riyadh Night Site' },
    attendance: [],
    ...partial,
  };
}

describe('export date range parsing', () => {
  it('legacy ?date= still works as a one-day range', () => {
    const range = parseExportRange({ date: '2026-09-23' });
    assert.deepEqual(range, { ok: true, from: '2026-09-23', to: '2026-09-23' });
  });

  it('from/to inclusive range is accepted', () => {
    const range = parseExportRange({ from: '2026-09-01', to: '2026-09-30' });
    assert.equal(range.ok, true);
    if (range.ok) {
      assert.equal(range.from, '2026-09-01');
      assert.equal(range.to, '2026-09-30');
      assert.equal(countInclusiveDays(range.from, range.to), 30);
      assert.deepEqual(enumerateWorkDates('2026-09-21', '2026-09-23'), [
        '2026-09-21',
        '2026-09-22',
        '2026-09-23',
      ]);
    }
  });

  it('invalid from/to rejected', () => {
    assert.equal(parseExportRange({}).ok, false);
    assert.equal(parseExportRange({ from: 'nope', to: '2026-09-01' }).ok, false);
    assert.equal(parseExportRange({ from: '2026-09-31', to: '2026-09-31' }).ok, false);
  });

  it('from > to rejected', () => {
    const range = parseExportRange({ from: '2026-09-30', to: '2026-09-01' });
    assert.equal(range.ok, false);
    if (!range.ok) assert.match(range.error, /from must be on or before to/);
  });

  it('range > 366 days rejected', () => {
    const range = parseExportRange({ from: '2025-01-01', to: '2026-12-31' });
    assert.equal(range.ok, false);
    if (!range.ok) assert.equal(range.error, 'Date range too large');
    assert.equal(MAX_EXPORT_DAYS, 366);
    const year = parseExportRange({ from: '2026-01-01', to: '2026-12-31' });
    assert.equal(year.ok, true);
  });
});

describe('export filename', () => {
  it('filename correct for one day', () => {
    assert.equal(exportFilename('2026-09-23', '2026-09-23'), 'attendance-2026-09-23.csv');
  });

  it('filename correct for range', () => {
    assert.equal(
      exportFilename('2026-09-01', '2026-09-30'),
      'attendance-2026-09-01-to-2026-09-30.csv'
    );
  });
});

describe('export rows', () => {
  const afterWindow = new Date('2026-09-21T13:00:00.000Z'); // 16:00 Riyadh
  const beforeWindow = new Date('2026-09-21T10:00:00.000Z'); // 13:00 Riyadh

  it('one-day export includes a punched employee', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
          shift: shift1,
          attendance: [
            {
              checkInAt: new Date('2026-09-21T12:40:00.000Z'),
              checkOutAt: new Date('2026-09-22T00:13:00.000Z'),
              workedMinutes: 703,
              lateMinutes: 10,
              earlyLeaveMinutes: 0,
              overtimeMinutes: 0,
              statusPrimary: 'ON_TIME',
              flags: '["ON_TIME"]',
            },
          ],
        }),
      ],
      afterWindow
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workDate, '2026-09-21');
    assert.equal(rows[0].bn, '71326');
    assert.equal(rows[0].shift, 'Shift 1');
    assert.equal(rows[0].status, 'ON_TIME');
    assert.equal(rows[0].worked, '11h 43m');
    assert.equal(rows[0].scheduledStart, '3:30 PM');
    assert.equal(rows[0].scheduledEnd, '3:30 AM');
    assert.notEqual(rows[0].checkIn, '—');
  });

  it('scheduled employee with no attendance and expired shift => ABSENT', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          employee: person('Turki Daher M AlShammari', '71378'),
          shift: shift1,
        }),
      ],
      afterWindow
    );
    assert.equal(rows[0].status, 'ABSENT');
    assert.equal(rows[0].checkIn, '—');
    assert.equal(rows[0].checkOut, '—');
    assert.equal(rows[0].worked, '—');
    assert.equal(rows[0].late, '—');
    assert.equal(rows[0].earlyLeave, '—');
    assert.equal(rows[0].ot, '—');
  });

  it('future scheduled employee without attendance => SCHEDULED, not ABSENT', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          employee: person('Abdullah Mahmoud B AlAnazi', '71343'),
          shift: shift2,
        }),
      ],
      beforeWindow
    );
    assert.equal(rows[0].status, 'SCHEDULED');
    assert.notEqual(rows[0].status, 'ABSENT');
    assert.equal(rows[0].checkIn, '—');
  });

  it('OFF excluded', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          status: 'OFF',
          employee: person('Turki Daher M AlShammari', '71378'),
          shift: shift1,
        }),
      ],
      afterWindow
    );
    assert.equal(rows.length, 0);
  });

  it('multiple days exported correctly', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
          shift: shift1,
        }),
        asg({
          workDate: '2026-09-22',
          employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
          shift: shift2,
        }),
      ],
      new Date('2026-09-25T12:00:00.000Z')
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.workDate), ['2026-09-21', '2026-09-22']);
    assert.equal(rows[1].shift, 'Shift 2');
  });

  it('no 500-row truncation', () => {
    const assignments = Array.from({ length: 501 }, (_, i) =>
      asg({
        workDate: '2026-09-21',
        employee: person(`Employee ${String(i).padStart(3, '0')}`, `7${String(i).padStart(4, '0')}`),
        shift: shift1,
      })
    );
    const rows = buildExportRows(assignments, afterWindow);
    assert.equal(rows.length, 501);
  });

  it('demo employees are excluded but inactive real employees stay', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          employee: person('Demo Employee', 'EMP-0147', { active: false }),
          shift: shift1,
        }),
        asg({
          workDate: '2026-09-21',
          employee: person('Abdullah Mahmoud B AlAnazi', '71343', { active: false }),
          shift: shift1,
        }),
      ],
      afterWindow
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bn, '71343');
    assert.equal(includeExportEmployee(person('Demo Employee', 'EMP-0147')), false);
  });
});

describe('CSV quality', () => {
  it('CSV contains Work Date / Shift / scheduled times and Riyadh formatting', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          employee: person('Abdulaziz "Aziz" AlZahrani', '71326'),
          shift: shift1,
          attendance: [
            {
              checkInAt: new Date('2026-09-21T12:40:00.000Z'),
              checkOutAt: null,
              workedMinutes: null,
              lateMinutes: 10,
              earlyLeaveMinutes: 0,
              overtimeMinutes: 0,
              statusPrimary: 'LATE',
              flags: '["LATE"]',
            },
          ],
        }),
      ],
      new Date('2026-09-21T13:00:00.000Z')
    );
    const csv = rowsToCsv(rows);
    assert.equal(csv.startsWith('\uFEFF'), true);
    assert.match(csv, /Work Date,Employee,BN,Shift,Project,Scheduled Start,Scheduled End/);
    assert.match(csv, /2026-09-21/);
    assert.match(csv, /Shift 1/);
    assert.match(csv, /3:30 PM/);
    assert.match(csv, /3:30 AM/);
    assert.match(csv, /Abdulaziz ""Aziz"" AlZahrani/);
    assert.equal(exportShiftName(shift1), 'Shift 1');
    assert.equal(csvEscape('a"b'), '"a""b"');
  });

  it('export roles stay ADMIN/HR/SUPERVISOR', () => {
    assert.equal(canExportAttendance('ADMIN'), true);
    assert.equal(canExportAttendance('HR'), true);
    assert.equal(canExportAttendance('SUPERVISOR'), true);
    assert.equal(canExportAttendance('SECURITY'), false);
    assert.equal(canExportAttendance('EMPLOYEE'), false);
  });
});
