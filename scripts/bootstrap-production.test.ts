import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertBootstrapAllowed,
  assertSafeAdminPassword,
  computeCrossesMidnight,
  parseGraceMinutes,
  parseHHMM,
  parseLatitude,
  parseLongitude,
  parseRadiusMeters,
  parseTerminalSlug,
  readBootstrapInput,
  BootstrapError,
} from './bootstrap-production';

function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PROD_ADMIN_USERNAME: 'ops-admin',
    PROD_ADMIN_PASSWORD: 'a-strong-password',
    PROD_ADMIN_FULL_NAME: 'Operations Admin',
    PROD_ADMIN_EMPLOYEE_CODE: 'ADM-0001',
    PROD_ADMIN_BADGE_NUMBER: '1001',
    PROD_PROJECT_NAME: 'Riyadh Night Site',
    PROD_PROJECT_CODE: 'RYD-01',
    PROD_PROJECT_LOCATION_LABEL: 'Riyadh',
    PROD_PROJECT_LATITUDE: '24.7136',
    PROD_PROJECT_LONGITUDE: '46.6753',
    PROD_PROJECT_RADIUS_METERS: '150',
    PROD_SHIFT_NAME: 'Night Shift',
    PROD_SHIFT_START_TIME: '18:00',
    PROD_SHIFT_END_TIME: '06:00',
    PROD_SHIFT_GRACE_MINUTES: '5',
    PROD_TERMINAL_NAME: 'Gate Tablet',
    PROD_TERMINAL_SLUG: 'riyadh-gate',
    ...overrides,
  };
}

describe('production bootstrap guards and validation', () => {
  it('refuses to run unless NODE_ENV is production', () => {
    assert.throws(
      () => assertBootstrapAllowed('development', undefined),
      (err: unknown) => err instanceof BootstrapError && /NODE_ENV is not "production"/.test(err.message)
    );
  });

  it('allows an explicit test override without production NODE_ENV', () => {
    assert.doesNotThrow(() => assertBootstrapAllowed('development', '1'));
    assert.doesNotThrow(() => assertBootstrapAllowed('production', undefined));
  });

  it('parses a night shift 18:00 → 06:00 as crossing midnight', () => {
    assert.equal(parseHHMM('18:00', 'PROD_SHIFT_START_TIME'), '18:00');
    assert.equal(parseHHMM('06:00', 'PROD_SHIFT_END_TIME'), '06:00');
    assert.equal(computeCrossesMidnight('18:00', '06:00'), true);
    assert.equal(computeCrossesMidnight('08:00', '17:00'), false);
  });

  it('rejects invalid HH:mm values', () => {
    assert.throws(() => parseHHMM('25:00', 'PROD_SHIFT_START_TIME'), BootstrapError);
    assert.throws(() => parseHHMM('18', 'PROD_SHIFT_START_TIME'), BootstrapError);
    assert.throws(() => parseHHMM('18:0', 'PROD_SHIFT_START_TIME'), BootstrapError);
  });

  it('validates coordinates and radius', () => {
    assert.equal(parseLatitude('26.3252708'), 26.3252708);
    assert.equal(parseLongitude('50.0743019'), 50.0743019);
    assert.equal(parseRadiusMeters('200'), 200);
    assert.throws(() => parseLatitude('100'), BootstrapError);
    assert.throws(() => parseLongitude('200'), BootstrapError);
    assert.throws(() => parseRadiusMeters('0'), BootstrapError);
    assert.throws(() => parseRadiusMeters('12.5'), BootstrapError);
  });

  it('rejects demo admin passwords and incomplete env', () => {
    assert.throws(() => assertSafeAdminPassword('admin123'), BootstrapError);
    assert.throws(() => assertSafeAdminPassword('1234'), BootstrapError);
    assert.throws(() => assertSafeAdminPassword('short'), BootstrapError);
    assert.throws(() => readBootstrapInput({}), BootstrapError);
    assert.throws(() => parseGraceMinutes('-1'), BootstrapError);
    assert.throws(() => parseTerminalSlug('Riyadh Gate'), BootstrapError);
  });

  it('reads required env without exposing the password on the returned object shape', () => {
    const input = readBootstrapInput(validEnv());
    assert.equal(input.adminUsername, 'ops-admin');
    assert.equal(input.crossesMidnight, true);
    assert.equal(input.terminalSlug, 'riyadh-gate');
    assert.ok('adminPassword' in input);
    assert.notEqual(input.adminPassword, 'admin123');
  });
});
