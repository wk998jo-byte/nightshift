import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_EXPORT_DAYS,
  buildExportRows,
  canExportAttendance,
  countInclusiveDays,
  csvEscape,
  enumerateWorkDates,
  exportAssignmentWhere,
  exportDownloadUrl,
  exportEmployeeLabel,
  exportFilename,
  exportShiftName,
  includeExportEmployee,
  listExportableEmployees,
  parseExportRange,
  resolveExportEmployee,
  rowsToCsv,
  sanitizeExportFilenamePart,
  summarizeExportRows,
  EXPORT_COLUMNS,
  EXPORT_SUMMARY_COLUMNS,
  type ExportAssignment,
} from './attendance-export';
import type { DayExceptionRecord } from './day-status';

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
  startTime: '19:00',
  endTime: '07:00',
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
  it('244 numeric OT exports as 4h 04m without changing the summary arithmetic', () => {
    const rows = buildExportRows([asg({
      employeeId: 'duration-fixture',
      workDate: '2026-09-21',
      employee: person('Duration Fixture', '98765'),
      shift: shift1,
      attendance: [{
        checkInAt: new Date('2026-09-21T12:30:00Z'),
        checkOutAt: new Date('2026-09-22T00:34:00Z'),
        workedMinutes: 724,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 244,
        statusPrimary: 'ON_TIME',
        flags: '["PRESENT","ON_TIME","OVERTIME"]',
      }],
    })], new Date('2026-09-22T12:00:00Z'));
    assert.equal(rows[0].ot, '4h 04m');
    assert.equal(rows[0].overtimeMinutes, 244);
    assert.equal(summarizeExportRows(rows)[0].totalOtMinutes, 244);
    assert.equal(summarizeExportRows(rows)[0].totalOt, '4h 04m');
    const csv = rowsToCsv(rows);
    assert.equal(csv.startsWith('\uFEFF'), true);
    assert.match(csv, /,OT,/);
    assert.match(csv, /4h 04m/);
    assert.equal(csv.includes('OT (min)'), false);
  });
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
  it('filename for All Employees uses attendance-all and the date range', () => {
    assert.equal(
      exportFilename('2026-10-01', '2026-10-31'),
      'attendance-all-2026-10-01-to-2026-10-31.csv'
    );
    assert.equal(
      exportFilename('2026-09-23', '2026-09-23'),
      'attendance-all-2026-09-23-to-2026-09-23.csv'
    );
  });

  it('filename for one employee uses BN, not the full name', () => {
    assert.equal(
      exportFilename('2026-10-01', '2026-10-31', { employeeCode: '71326' }),
      'attendance-71326-2026-10-01-to-2026-10-31.csv'
    );
    assert.equal(sanitizeExportFilenamePart('Abdulaziz Abdullah H AlZahrani'), 'AbdulazizAbdullahHAlZahrani');
    assert.equal(sanitizeExportFilenamePart('71326'), '71326');
  });
});

describe('export rows', () => {
  const afterWindow = new Date('2026-09-21T13:00:00.000Z'); // 16:00 Riyadh, Shift 1 still running
  const afterShiftEnd = new Date('2026-09-22T00:31:00.000Z'); // 03:31 Riyadh next day
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

  it('scheduled employee with no attendance during an active shift => SCHEDULED', () => {
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
    assert.equal(rows[0].status, 'SCHEDULED');
    assert.notEqual(rows[0].status, 'ABSENT');
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
      afterShiftEnd
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

  it('OFF assignment appears with OFF shift/status and no placeholder times', () => {
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
    assert.equal(rows.length, 1);
    assert.equal(rows[0].shift, 'OFF');
    assert.equal(rows[0].status, 'OFF');
    assert.equal(rows[0].flags, 'OFF');
    assert.equal(rows[0].scheduledStart, '—');
    assert.equal(rows[0].scheduledEnd, '—');
    assert.equal(rows[0].checkIn, '—');
    assert.equal(rows[0].checkOut, '—');
    assert.equal(rows[0].worked, '—');
    assert.equal(rows[0].late, '—');
    assert.equal(rows[0].earlyLeave, '—');
    assert.equal(rows[0].ot, '—');
    assert.equal(rows[0].project, 'Riyadh Night Site');
    assert.equal(rows[0].bn, '71378');
    const csv = rowsToCsv(rows);
    assert.match(csv, /"OFF"/);
    assert.equal(csv.includes('3:30 PM'), false);
    assert.equal(csv.includes('15:30'), false);
    assert.equal(csv.includes('Shift 1'), false);
  });

  it('NO_SCHEDULE still does not appear', () => {
    const rows = buildExportRows([], afterWindow);
    assert.equal(rows.length, 0);
    const leftover = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          status: 'LEAVE',
          employee: person('Turki Daher M AlShammari', '71378'),
          shift: shift1,
        }),
      ],
      afterWindow
    );
    assert.equal(leftover.length, 0);
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
    assert.match(csv, /Short \(min\)/);
    assert.equal(csv.includes('Early Leave (min)'), false);
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

describe('export administrative statuses', () => {
  const afterWindow = new Date('2026-09-21T13:00:00.000Z');

  it('excused days show dashes and the exception status', () => {
    const types: DayExceptionRecord['type'][] = [
      'HOLIDAY',
      'SICK_LEAVE',
      'UMRA_LEAVE',
      'HALF_DAY',
      'EMERGENCY_VACATION',
      'VACATION',
      'RELEASED',
      'NEW',
    ];
    for (const type of types) {
      const rows = buildExportRows(
        [
          asg({
            employeeId: 'e1',
            workDate: '2026-09-21',
            employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
            shift: shift1,
          }),
        ],
        afterWindow,
        [
          {
            workDate: '2026-09-21',
            employeeId: type === 'HOLIDAY' ? null : 'e1',
            type,
            expectedStartTime: type === 'HALF_DAY' ? '15:30' : null,
            expectedEndTime: type === 'HALF_DAY' ? '23:30' : null,
          },
        ]
      );
      assert.equal(rows[0].status, type);
      assert.equal(rows[0].checkIn, '—');
      assert.equal(rows[0].checkOut, '—');
      assert.equal(rows[0].worked, '—');
      assert.equal(rows[0].late, '—');
      assert.equal(rows[0].earlyLeave, '—');
      assert.equal(rows[0].ot, '—');
    }
  });

  it('Holiday Work shows worked minutes and OT', () => {
    const rows = buildExportRows(
      [
        asg({
          employeeId: 'e1',
          workDate: '2026-09-21',
          employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
          shift: shift1,
          attendance: [
            {
              checkInAt: new Date('2026-09-21T12:30:00.000Z'),
              checkOutAt: new Date('2026-09-22T00:30:00.000Z'),
              workedMinutes: 720,
              lateMinutes: 0,
              earlyLeaveMinutes: 0,
              overtimeMinutes: 0,
              statusPrimary: 'ON_TIME',
              flags: '["ON_TIME"]',
            },
          ],
        }),
      ],
      afterWindow,
      [{ workDate: '2026-09-21', employeeId: null, type: 'HOLIDAY' }]
    );
    assert.equal(rows[0].status, 'HOLIDAY_WORK');
    assert.notEqual(rows[0].checkIn, '—');
    assert.notEqual(rows[0].checkOut, '—');
    assert.equal(rows[0].worked, '12h 00m');
    assert.equal(rows[0].ot, '12h 00m');
    const holidaySummary = summarizeExportRows(rows);
    assert.equal(holidaySummary[0].totalOt, '12h 00m');
    assert.equal(holidaySummary[0].totalOtMinutes, 720);
  });

  it('completed 12-hour ON_TIME row exports duration OT and retains numeric totals', () => {
    const rows = buildExportRows(
      [
        asg({
          employeeId: 'e1',
          workDate: '2026-09-21',
          employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
          shift: shift1,
          attendance: [
            {
              checkInAt: new Date('2026-09-21T12:30:00.000Z'),
              checkOutAt: new Date('2026-09-22T00:30:00.000Z'),
              workedMinutes: 720,
              lateMinutes: 0,
              earlyLeaveMinutes: 0,
              overtimeMinutes: 240,
              statusPrimary: 'ON_TIME',
              flags: '["PRESENT","ON_TIME","OVERTIME"]',
            },
          ],
        }),
      ],
      afterWindow
    );
    assert.equal(rows[0].status, 'ON_TIME');
    assert.equal(rows[0].worked, '12h 00m');
    assert.equal(rows[0].ot, '4h 00m');
    assert.equal(rows[0].overtimeMinutes, 240);
    assert.equal(rows[0].late, '0');
    assert.equal(rows[0].earlyLeave, '0');
    assert.match(rows[0].flags, /OVERTIME/);
  });

  it('OFF remains OFF and date-range behavior stays intact', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          status: 'OFF',
          employee: person('Turki Daher M AlShammari', '71378'),
          shift: shift1,
        }),
        asg({
          workDate: '2026-09-22',
          employee: person('Turki Daher M AlShammari', '71378'),
          shift: shift2,
        }),
      ],
      new Date('2026-09-25T12:00:00.000Z')
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'OFF');
    assert.equal(rows[0].shift, 'OFF');
    assert.equal(rows[1].workDate, '2026-09-22');
    assert.equal(rows[1].status, 'ABSENT');
  });

  it('stale missing checkout exports dashes instead of a long worked duration', () => {
    const rows = buildExportRows(
      [
        asg({
          workDate: '2026-09-21',
          employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
          shift: { ...shift1, checkoutWindowAfterMinutes: 180 },
          attendance: [
            {
              checkInAt: new Date('2026-09-21T12:40:00.000Z'),
              checkOutAt: null,
              workedMinutes: 1455,
              lateMinutes: 10,
              earlyLeaveMinutes: 0,
              overtimeMinutes: 745,
              statusPrimary: 'WORKING',
              flags: '["WORKING"]',
            },
          ],
        }),
      ],
      new Date('2026-09-22T05:00:00.000Z')
    );
    assert.equal(rows[0].status, 'MISSING_CHECKOUT');
    assert.notEqual(rows[0].checkIn, '—');
    assert.equal(rows[0].checkOut, '—');
    assert.equal(rows[0].worked, '—');
    assert.equal(rows[0].ot, '—');
    assert.equal(rows[0].earlyLeave, '—');
    assert.notEqual(rows[0].worked, '24h 15m');
  });

  it('explicit ABSENT exception is exported as ABSENT', () => {
    const rows = buildExportRows(
      [
        asg({
          employeeId: 'e1',
          workDate: '2026-09-21',
          employee: person('Abdullah Mahmoud B AlAnazi', '71343'),
          shift: shift1,
        }),
      ],
      new Date('2026-09-21T10:00:00.000Z'),
      [{ workDate: '2026-09-21', employeeId: 'e1', type: 'ABSENT' }]
    );
    assert.equal(rows[0].status, 'ABSENT');
  });

  it('Half Day with a completed punch keeps stored metrics and does not recalculate', () => {
    const rows = buildExportRows(
      [
        asg({
          employeeId: 'e1',
          workDate: '2026-09-21',
          employee: person('Turki Daher M AlShammari', '71378'),
          shift: shift1,
          attendance: [
            {
              checkInAt: new Date('2026-09-21T12:30:00.000Z'),
              checkOutAt: new Date('2026-09-21T16:30:00.000Z'),
              scheduledStart: new Date('2026-09-21T12:30:00.000Z'),
              scheduledEnd: new Date('2026-09-21T16:30:00.000Z'),
              workedMinutes: 240,
              lateMinutes: 0,
              earlyLeaveMinutes: 0,
              overtimeMinutes: 0,
              statusPrimary: 'ON_TIME',
              flags: '["PRESENT","ON_TIME","HALF_DAY"]',
            },
          ],
        }),
      ],
      afterWindow,
      [
        {
          workDate: '2026-09-21',
          employeeId: 'e1',
          type: 'HALF_DAY',
          expectedStartTime: '15:30',
          expectedEndTime: '19:30',
          expectedWorkMinutes: 240,
        },
      ]
    );
    assert.equal(rows[0].worked, '4h 00m');
    assert.equal(rows[0].ot, '0h 00m');
    assert.equal(rows[0].earlyLeave, '0');
    assert.match(rows[0].flags, /HALF_DAY/);
  });
});

describe('export employee filter and summaries', () => {
  const afterWindow = new Date('2026-10-09T12:00:00.000Z');

  function completed(
    employeeId: string,
    name: string,
    code: string,
    workDate: string,
    metrics: {
      workedMinutes: number;
      lateMinutes: number;
      earlyLeaveMinutes: number;
      overtimeMinutes: number;
      statusPrimary?: string;
      flags?: string;
      checkInAt?: Date;
      checkOutAt?: Date;
      scheduledStart?: Date;
      scheduledEnd?: Date;
    }
  ): ExportAssignment {
    return asg({
      employeeId,
      workDate,
      employee: person(name, code),
      shift: shift1,
      attendance: [
        {
          checkInAt: metrics.checkInAt || new Date('2026-10-08T12:30:00.000Z'),
          checkOutAt: metrics.checkOutAt || new Date('2026-10-09T00:30:00.000Z'),
          scheduledStart: metrics.scheduledStart,
          scheduledEnd: metrics.scheduledEnd,
          workedMinutes: metrics.workedMinutes,
          lateMinutes: metrics.lateMinutes,
          earlyLeaveMinutes: metrics.earlyLeaveMinutes,
          overtimeMinutes: metrics.overtimeMinutes,
          statusPrimary: metrics.statusPrimary || 'ON_TIME',
          flags: metrics.flags || '["PRESENT","ON_TIME"]',
        },
      ],
    });
  }

  const abdulaziz = completed('e-az', 'Abdulaziz Abdullah H AlZahrani', '71326', '2026-10-08', {
    workedMinutes: 720,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 240,
    statusPrimary: 'ON_TIME',
    flags: '["PRESENT","ON_TIME","OVERTIME"]',
  });
  const abdullah = completed('e-an', 'Abdullah Mahmoud B AlAnazi', '71343', '2026-10-08', {
    workedMinutes: 540,
    lateMinutes: 20,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 60,
    statusPrimary: 'LATE',
    flags: '["PRESENT","LATE","OVERTIME"]',
    checkInAt: new Date('2026-10-08T12:50:00.000Z'),
    checkOutAt: new Date('2026-10-08T21:50:00.000Z'),
  });
  const turkiOff = asg({
    employeeId: 'e-tu',
    workDate: '2026-10-08',
    status: 'OFF',
    employee: person('Turki Daher M AlShammari', '71378'),
    shift: shift1,
  });

  it('All Employees export includes multiple employees', () => {
    const rows = buildExportRows([abdulaziz, abdullah, turkiOff], afterWindow);
    assert.deepEqual(rows.map((r) => r.bn).sort(), ['71326', '71343', '71378']);
  });

  it('one employee filter returns only that employee in detail and summary', () => {
    const rows = buildExportRows([abdulaziz, abdullah, turkiOff], afterWindow, [], {
      employeeId: 'e-az',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bn, '71326');
    const summary = summarizeExportRows(rows);
    assert.equal(summary.length, 1);
    assert.equal(summary[0].bn, '71326');
  });

  it('invalid employeeId is rejected', () => {
    assert.equal(resolveExportEmployee(null).ok, false);
    assert.equal(resolveExportEmployee(undefined).ok, false);
    assert.equal(
      resolveExportEmployee({
        id: 'demo',
        fullName: 'Demo Employee',
        employeeCode: 'EMP-0147',
        user: { role: 'EMPLOYEE', isActive: true },
      }).ok,
      false
    );
    const ok = resolveExportEmployee({
      id: 'e-az',
      fullName: 'Abdulaziz Abdullah H AlZahrani',
      employeeCode: '71326',
      badgeNumber: '71326',
      user: { role: 'EMPLOYEE', isActive: true },
    });
    assert.equal(ok.ok, true);
  });

  it('cross-midnight checkout stays on the night workDate', () => {
    const rows = buildExportRows(
      [
        completed('e-az', 'Abdulaziz Abdullah H AlZahrani', '71326', '2026-10-08', {
          workedMinutes: 720,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeMinutes: 240,
          checkInAt: new Date('2026-10-08T16:00:00.000Z'),
          checkOutAt: new Date('2026-10-09T04:00:20.000Z'),
        }),
      ],
      afterWindow
    );
    assert.equal(rows[0].workDate, '2026-10-08');
    assert.equal(rows[0].worked, '12h 00m');
  });

  it('historical stored Shift 2 19:30-07:30 window is exported as stored', () => {
    const storedStart = new Date('2026-09-26T16:30:00.000Z');
    const storedEnd = new Date('2026-09-27T04:30:00.000Z');
    const rows = buildExportRows(
      [
        asg({
          employeeId: 'e-az',
          workDate: '2026-09-26',
          employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
          shift: shift2,
          attendance: [
            {
              checkInAt: storedStart,
              checkOutAt: storedEnd,
              scheduledStart: storedStart,
              scheduledEnd: storedEnd,
              workedMinutes: 720,
              lateMinutes: 0,
              earlyLeaveMinutes: 0,
              overtimeMinutes: 240,
              statusPrimary: 'ON_TIME',
              flags: '["PRESENT","ON_TIME","OVERTIME"]',
            },
          ],
        }),
      ],
      new Date('2026-09-27T12:00:00.000Z')
    );
    assert.equal(rows[0].scheduledStart, '7:30 PM');
    assert.equal(rows[0].scheduledEnd, '7:30 AM');
    assert.notEqual(rows[0].scheduledStart, '7:00 PM');
  });

  it('Late + OT exports both metrics and keeps ON_TIME + OT as ON_TIME', () => {
    const rows = buildExportRows([abdulaziz, abdullah], afterWindow);
    const lateOt = rows.find((r) => r.bn === '71343')!;
    const onTimeOt = rows.find((r) => r.bn === '71326')!;
    assert.equal(lateOt.status, 'LATE');
    assert.equal(lateOt.late, '20');
    assert.equal(lateOt.ot, '1h 00m');
    assert.equal(onTimeOt.status, 'ON_TIME');
    assert.equal(onTimeOt.ot, '4h 00m');
    assert.match(onTimeOt.flags, /OVERTIME/);
  });

  it('missing checkout increments summary and OFF does not', () => {
    const missing = asg({
      employeeId: 'e-az',
      workDate: '2026-10-07',
      employee: person('Abdulaziz Abdullah H AlZahrani', '71326'),
      shift: { ...shift1, checkoutWindowAfterMinutes: 180 },
      attendance: [
        {
          checkInAt: new Date('2026-10-07T12:30:00.000Z'),
          checkOutAt: null,
          workedMinutes: null,
          lateMinutes: 6,
          earlyLeaveMinutes: 0,
          overtimeMinutes: 0,
          statusPrimary: 'WORKING',
          flags: '["PRESENT","LATE","WORKING"]',
        },
      ],
    });
    const rows = buildExportRows([missing, turkiOff, abdulaziz], afterWindow);
    const az = rows.filter((r) => r.bn === '71326');
    const tu = rows.filter((r) => r.bn === '71378');
    assert.equal(az.some((r) => r.status === 'MISSING_CHECKOUT'), true);
    assert.equal(tu[0].status, 'OFF');
    const summary = summarizeExportRows(rows);
    const azSum = summary.find((r) => r.bn === '71326')!;
    const tuSum = summary.find((r) => r.bn === '71378')!;
    assert.equal(azSum.missingCheckout, 1);
    assert.equal(tuSum.missingCheckout, 0);
    assert.equal(azSum.lateDays, 1);
    assert.equal(azSum.totalWorked, '12h 00m');
    assert.equal(azSum.totalOt, '4h 00m');
    assert.equal(azSum.totalLateMinutes, 6);
  });

  it('summary totals and Late Days sum correctly for All Employees and one employee', () => {
    const secondAz = completed('e-az', 'Abdulaziz Abdullah H AlZahrani', '71326', '2026-10-09', {
      workedMinutes: 420,
      lateMinutes: 16,
      earlyLeaveMinutes: 60,
      overtimeMinutes: 0,
      statusPrimary: 'LATE',
      flags: '["PRESENT","LATE","EARLY_DEPARTURE"]',
      checkInAt: new Date('2026-10-09T12:46:00.000Z'),
      checkOutAt: new Date('2026-10-09T19:46:00.000Z'),
    });
    const allRows = buildExportRows([abdulaziz, secondAz, abdullah, turkiOff], afterWindow);
    const allSummary = summarizeExportRows(allRows);
    assert.equal(allSummary.length, 3);
    const az = allSummary.find((r) => r.bn === '71326')!;
    assert.equal(az.totalWorked, '19h 00m');
    assert.equal(az.totalLateMinutes, 16);
    assert.equal(az.totalShortMinutes, 60);
    assert.equal(az.totalOt, '4h 00m');
    assert.equal(az.lateDays, 1);
    assert.equal(az.missingCheckout, 0);
    const one = summarizeExportRows(
      buildExportRows([abdulaziz, secondAz, abdullah], afterWindow, [], { employeeId: 'e-az' })
    );
    assert.equal(one.length, 1);
    assert.equal(one[0].bn, '71326');
    const csv = rowsToCsv(allRows);
    assert.match(csv, /Detailed Attendance/);
    assert.match(csv, /\n\nSummary\n/);
    assert.match(csv, /Total Worked,Total Late Minutes,Total Short Minutes,Total OT,/);
    assert.match(csv, /,OT,/);
    assert.equal(csv.includes('OT (min)'), false);
    assert.equal(csv.includes('Total OT Minutes'), false);
    assert.deepEqual(EXPORT_SUMMARY_COLUMNS, [
      'Employee',
      'BN',
      'Total Worked',
      'Total Late Minutes',
      'Total Short Minutes',
      'Total OT',
      'Late Days',
      'Missing Checkout',
    ]);
    assert.equal(EXPORT_COLUMNS.includes('OT'), true);
    assert.match(csv, /19h 00m/);
  });

  it('does not leak demo employees into rows, summary, or the selector', () => {
    const demo = asg({
      employeeId: 'e-demo',
      workDate: '2026-10-08',
      employee: person('Demo Employee', 'EMP-0147'),
      shift: shift1,
    });
    const rows = buildExportRows([demo, abdulaziz], afterWindow);
    assert.deepEqual(rows.map((r) => r.bn), ['71326']);
    assert.deepEqual(summarizeExportRows(rows).map((r) => r.bn), ['71326']);
    assert.deepEqual(
      listExportableEmployees([
        { id: 'e-demo', fullName: 'Demo Employee', employeeCode: 'EMP-0147', user: { role: 'EMPLOYEE', isActive: true } },
        { id: 'e-admin', fullName: 'Admin User', employeeCode: 'ADMIN', user: { role: 'ADMIN', isActive: true } },
        { id: 'e-az', fullName: 'Abdulaziz Abdullah H AlZahrani', employeeCode: '71326', badgeNumber: '71326', isActive: false, user: { role: 'EMPLOYEE', isActive: false } },
      ]).map((r) => r.employeeCode),
      ['71326']
    );
    assert.equal(
      exportEmployeeLabel({ fullName: 'Abdulaziz Abdullah H AlZahrani', employeeCode: '71326', badgeNumber: '71326' }),
      'Abdulaziz Abdullah H AlZahrani — 71326'
    );
  });

  it('keeps existing projectId filter support and UTF-8 BOM', () => {
    const where = exportAssignmentWhere({
      from: '2026-10-01',
      to: '2026-10-31',
      projectId: 'proj-1',
      employeeId: 'e-az',
    });
    assert.equal(where.projectId, 'proj-1');
    assert.equal(where.employeeId, 'e-az');
    assert.deepEqual(where.workDate, { gte: '2026-10-01', lte: '2026-10-31' });
    const allWhere = exportAssignmentWhere({ from: '2026-10-01', to: '2026-10-31' });
    assert.equal('projectId' in allWhere, false);
    assert.equal('employeeId' in allWhere, false);
    const csv = rowsToCsv(buildExportRows([abdulaziz], afterWindow));
    assert.equal(csv.startsWith('\uFEFF'), true);
    assert.equal(
      exportDownloadUrl('2026-10-01', '2026-10-31', { employeeId: 'e-az', projectId: 'proj-1' }),
      '/api/exports/attendance?from=2026-10-01&to=2026-10-31&employeeId=e-az&projectId=proj-1'
    );
  });
});
