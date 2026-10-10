import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { scheduledWindow } from './attendance-calc';
import {
  formatAttendance8hAuditReport,
  proposeCompletedAttendanceMetrics,
  summarizeAttendance8hAudit,
} from './attendance-8h-audit';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

function riyadh(isoLocal: string): Date {
  return DateTime.fromISO(isoLocal, { zone: 'Asia/Riyadh' }).toJSDate();
}

describe('8-hour attendance dry-run audit helper', () => {
  it('proposes OT from 8 hours without changing stored schedule', () => {
    const window = scheduledWindow('2026-10-08', '19:00', '07:00', true);
    const proposed = proposeCompletedAttendanceMetrics({
      id: 'att1',
      workDate: '2026-10-08',
      employeeCode: '71326',
      employeeName: 'Abdulaziz Abdullah H AlZahrani',
      checkInAt: riyadh('2026-10-08T19:00:00'),
      checkOutAt: riyadh('2026-10-09T07:00:20'),
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      workedMinutes: 720,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      statusPrimary: 'ON_TIME',
      flags: '["PRESENT","ON_TIME"]',
      gracePeriodMinutes: 5,
      minWorkMinutes: null,
    });
    assert.equal(proposed.workedMinutes, 720);
    assert.equal(proposed.overtimeMinutes, 240);
    assert.equal(proposed.statusPrimary, 'ON_TIME');
  });

  it('prints a readable BEFORE -> AFTER dry-run for local sample rows', () => {
    const s1 = scheduledWindow('2026-10-08', '15:30', '03:30', true);
    const s2 = scheduledWindow('2026-10-08', '19:00', '07:00', true);
    const summary = summarizeAttendance8hAudit({
      skippedOpenOrMissing: 1,
      rows: [
        {
          id: 'att-az',
          workDate: '2026-10-08',
          employeeCode: '71326',
          employeeName: 'Abdulaziz Abdullah H AlZahrani',
          checkInAt: riyadh('2026-10-08T19:00:00'),
          checkOutAt: riyadh('2026-10-09T07:00:20'),
          scheduledStart: s2.scheduledStart,
          scheduledEnd: s2.scheduledEnd,
          workedMinutes: 720,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeMinutes: 0,
          statusPrimary: 'ON_TIME',
          flags: '["PRESENT","ON_TIME"]',
          gracePeriodMinutes: 5,
          minWorkMinutes: null,
        },
        {
          id: 'att-turki',
          workDate: '2026-10-08',
          employeeCode: '71378',
          employeeName: 'Turki Daher M AlShammari',
          checkInAt: riyadh('2026-10-08T15:30:00'),
          checkOutAt: riyadh('2026-10-09T03:34:13'),
          scheduledStart: s1.scheduledStart,
          scheduledEnd: s1.scheduledEnd,
          workedMinutes: 724,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeMinutes: 4,
          statusPrimary: 'OVERTIME',
          flags: '["PRESENT","ON_TIME","OVERTIME"]',
          gracePeriodMinutes: 5,
          minWorkMinutes: null,
        },
      ],
    });
    const report = formatAttendance8hAuditReport(summary);
    assert.match(report, /DRY RUN ONLY/);
    assert.match(report, /PRODUCTION WRITES: 0/);
    assert.equal(summary.inspected, 2);
    assert.equal(summary.otChanged, 2);
    assert.equal(summary.primaryChanged, 1);
    assert.match(report, /71326/);
    assert.match(report, /0 -> 240/);
    assert.match(report, /4 -> 244/);
    assert.match(report, /OVERTIME -> ON_TIME/);
    console.log('\n--- sample dry-run output ---\n' + report + '\n--- end sample ---\n');
  });
});
