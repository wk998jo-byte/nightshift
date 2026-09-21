import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  scheduledWindow,
  calculateAttendance,
  resolveWorkDateForShift,
  parseTimeOnDate,
} from './attendance-calc';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

function utc(iso: string): Date {
  return new Date(iso);
}

describe('Saudi night shift timezone (server TZ = UTC)', () => {
  it('maps 18:00 Asia/Riyadh on 2026-09-21 to 15:00Z', () => {
    const start = parseTimeOnDate('2026-09-21', '18:00');
    assert.equal(start.toISOString(), '2026-09-21T15:00:00.000Z');
  });

  it('scheduled window 18:00 → 06:00 crosses midnight in Riyadh', () => {
    const { scheduledStart, scheduledEnd } = scheduledWindow(
      '2026-09-21',
      '18:00',
      '06:00',
      true
    );
    assert.equal(scheduledStart.toISOString(), '2026-09-21T15:00:00.000Z');
    assert.equal(scheduledEnd.toISOString(), '2026-09-22T03:00:00.000Z');
  });

  it('workDate at shift start 18:00 Riyadh is 2026-09-21', () => {
    const now = utc('2026-09-21T15:00:00.000Z');
    assert.equal(resolveWorkDateForShift(now, '18:00', '06:00', true), '2026-09-21');
  });

  it('workDate after midnight 01:00 Riyadh belongs to previous workDate', () => {
    const now = utc('2026-09-21T22:00:00.000Z');
    assert.equal(resolveWorkDateForShift(now, '18:00', '06:00', true), '2026-09-21');
  });

  it('calculates late after grace from Riyadh scheduled start', () => {
    const { scheduledStart, scheduledEnd } = scheduledWindow(
      '2026-09-21',
      '18:00',
      '06:00',
      true
    );
    const result = calculateAttendance({
      scheduledStart,
      scheduledEnd,
      checkInAt: utc('2026-09-21T15:20:00.000Z'),
      checkOutAt: utc('2026-09-22T03:00:00.000Z'),
      gracePeriodMinutes: 5,
    });
    assert.equal(result.lateMinutes, 15);
    assert.equal(result.statusPrimary, 'LATE');
  });

  it('calculates early departure before 06:00 Riyadh', () => {
    const { scheduledStart, scheduledEnd } = scheduledWindow(
      '2026-09-21',
      '18:00',
      '06:00',
      true
    );
    const result = calculateAttendance({
      scheduledStart,
      scheduledEnd,
      checkInAt: utc('2026-09-21T15:00:00.000Z'),
      checkOutAt: utc('2026-09-22T02:00:00.000Z'),
      gracePeriodMinutes: 5,
    });
    assert.equal(result.earlyLeaveMinutes, 60);
    assert.equal(result.statusPrimary, 'EARLY_DEPARTURE');
  });

  it('calculates overtime after 06:00 Riyadh', () => {
    const { scheduledStart, scheduledEnd } = scheduledWindow(
      '2026-09-21',
      '18:00',
      '06:00',
      true
    );
    const result = calculateAttendance({
      scheduledStart,
      scheduledEnd,
      checkInAt: utc('2026-09-21T15:00:00.000Z'),
      checkOutAt: utc('2026-09-22T04:30:00.000Z'),
      gracePeriodMinutes: 5,
    });
    assert.equal(result.overtimeMinutes, 90);
    assert.equal(result.workedMinutes, 810);
    assert.equal(result.statusPrimary, 'OVERTIME');
  });
});
