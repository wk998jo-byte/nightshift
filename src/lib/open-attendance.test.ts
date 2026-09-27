import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduledWindow } from './attendance-calc';
import {
  checkInBlockedBy,
  classifyOpenAttendance,
  correctionPrefillFromMissingOut,
  dashboardOpenPunchAction,
  employeeOpenShiftFromRecords,
  isCurrentOpenAttendance,
  isStaleMissingCheckout,
  MISSING_OUT_DASHBOARD_ACTION,
  previousMissingCheckoutMeta,
  resolveCheckoutTarget,
  STALE_MISSING_CHECKOUT_CODE,
} from './open-attendance';

process.env.TZ = 'UTC';
process.env.APP_TIMEZONE = 'Asia/Riyadh';

const window = scheduledWindow('2026-09-26', '15:30', '03:30', true);
// Shift 1 ends 03:30 Riyadh Sep 27 = 2026-09-27T00:30:00.000Z
// Deadline +180m = 06:30 Riyadh = 2026-09-27T03:30:00.000Z
const beforeDeadline = new Date('2026-09-27T03:00:00.000Z'); // 06:00 Riyadh
const afterDeadline = new Date('2026-09-27T04:00:00.000Z'); // 07:00 Riyadh
const nextDayShift = new Date('2026-09-27T13:00:00.000Z'); // 16:00 Riyadh next day

function openRecord(id = 'att-1') {
  return {
    id,
    checkInAt: new Date('2026-09-26T12:40:00.000Z'),
    checkOutAt: null as Date | null,
    scheduledEnd: window.scheduledEnd,
    checkoutWindowAfterMinutes: 180,
    workDate: '2026-09-26',
  };
}

describe('open vs stale missing checkout', () => {
  it('open attendance before checkout deadline is CURRENT OPEN', () => {
    const record = openRecord();
    assert.equal(classifyOpenAttendance(record, beforeDeadline), 'CURRENT_OPEN');
    assert.equal(isCurrentOpenAttendance(record, beforeDeadline), true);
    assert.equal(isStaleMissingCheckout(record, beforeDeadline), false);
  });

  it('old attendance after checkout deadline is MISSING_CHECKOUT', () => {
    const record = openRecord();
    assert.equal(classifyOpenAttendance(record, afterDeadline), 'STALE_MISSING_CHECKOUT');
    assert.equal(isStaleMissingCheckout(record, afterDeadline), true);
    assert.equal(isCurrentOpenAttendance(record, afterDeadline), false);
  });

  it('stale previous attendance does not block today check-in', () => {
    assert.equal(checkInBlockedBy([openRecord()], nextDayShift), null);
    assert.ok(checkInBlockedBy([openRecord()], beforeDeadline));
  });

  it('stale previous attendance is not returned as employee openShift', () => {
    assert.equal(employeeOpenShiftFromRecords([openRecord()], nextDayShift), null);
    const current = employeeOpenShiftFromRecords([openRecord()], beforeDeadline);
    assert.equal(current?.id, 'att-1');
    const meta = previousMissingCheckoutMeta([openRecord()], nextDayShift);
    assert.ok(meta);
    assert.equal(meta?.attendanceId, 'att-1');
    assert.equal(meta?.workDate, '2026-09-26');
  });

  it('checkout endpoint cannot close stale previous attendance', () => {
    const stale = resolveCheckoutTarget([openRecord()], nextDayShift);
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.code, STALE_MISSING_CHECKOUT_CODE);
      assert.match(stale.error, /supervisor/i);
    }
    const current = resolveCheckoutTarget([openRecord()], beforeDeadline);
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.record.id, 'att-1');
  });

  it('dangerous close-now path is replaced by Fix OUT', () => {
    assert.equal(
      dashboardOpenPunchAction({ checkInAt: 'x', checkOutAt: null }),
      MISSING_OUT_DASHBOARD_ACTION
    );
    assert.equal(MISSING_OUT_DASHBOARD_ACTION, 'FIX_OUT');
    assert.notEqual(MISSING_OUT_DASHBOARD_ACTION, 'CLOSE');
    assert.deepEqual(
      correctionPrefillFromMissingOut({
        employeeId: 'e1',
        workDate: '2026-09-26',
        attendanceId: 'att-1',
      }),
      { employeeId: 'e1', workDate: '2026-09-26', attendanceId: 'att-1' }
    );
  });
});
