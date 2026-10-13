import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subscribeEmployeeForegroundRefresh } from './employee-live-refresh';
import { createPunchSubmissionGuard } from './employee-punch';
import { isRecoverableQrError, QR_RESCAN_MESSAGE } from './qr-errors';

test('foreground focus, visibility and pageshow coalesce, throttle and clean up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  let visible = true;
  let loads = 0;
  const cleanup = subscribeEmployeeForegroundRefresh(
    windowTarget, documentTarget, () => visible, () => { loads++; },
  );
  windowTarget.dispatchEvent(new Event('focus'));
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  windowTarget.dispatchEvent(new Event('pageshow'));
  t.mock.timers.tick(250);
  assert.equal(loads, 1);
  windowTarget.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(999);
  assert.equal(loads, 1);
  t.mock.timers.tick(1);
  assert.equal(loads, 2);
  visible = false;
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(1000);
  assert.equal(loads, 2);
  visible = true;
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(250);
  assert.equal(loads, 3);
  const restored = Object.assign(new Event('pageshow'), { persisted: true });
  windowTarget.dispatchEvent(restored);
  t.mock.timers.tick(1000);
  assert.equal(loads, 3, 'Safari BFCache is handled by the existing reload component');
  windowTarget.dispatchEvent(new Event('pageshow'));
  t.mock.timers.tick(250);
  assert.equal(loads, 4);
  windowTarget.dispatchEvent(new Event('focus'));
  cleanup();
  t.mock.timers.tick(2000);
  windowTarget.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(2000);
  assert.equal(loads, 4);
});

test('submission gate prevents duplicate GPS and rejects stale tokens until a new scan', () => {
  const gate = createPunchSubmissionGuard();
  let gpsCalls = 0;
  const submit = (token: string) => {
    const admission = gate.begin(token);
    if (admission === 'accepted') gpsCalls++;
    return admission;
  };
  assert.equal(submit('old'), 'accepted');
  assert.equal(submit('old'), 'busy');
  assert.equal(submit('new'), 'busy');
  gate.reject('old');
  gate.finish();
  assert.equal(submit('old'), 'stale');
  assert.equal(gpsCalls, 1);
  assert.equal(submit('new'), 'accepted');
  gate.finish();
  assert.equal(submit(''), 'empty');
  assert.equal(gpsCalls, 2);
});

test('only machine-readable QR failures allow rescan recovery', () => {
  for (const code of ['QR_INVALID_FORMAT', 'QR_INVALID_SIGNATURE', 'QR_EXPIRED', 'QR_SESSION_INVALID', 'QR_MISMATCH']) {
    assert.equal(isRecoverableQrError(code), true);
  }
  for (const code of ['NO_SCHEDULE', 'STALE_MISSING_CHECKOUT', 'CURRENT_OPEN', 'GPS_DENIED', undefined, 'QR project does not match your open shift project']) {
    assert.equal(isRecoverableQrError(code), false);
  }
  assert.equal(QR_RESCAN_MESSAGE, 'QR changed or expired. Scan the current code again.');
});
