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
    PROD_SHIFT_1_NAME: 'Night Shift 1',
    PROD_SHIFT_1_START_TIME: '15:30',
    PROD_SHIFT_1_END_TIME: '03:30',
    PROD_SHIFT_1_GRACE_MINUTES: '5',
    PROD_SHIFT_2_NAME: 'Night Shift 2',
    PROD_SHIFT_2_START_TIME: '19:30',
    PROD_SHIFT_2_END_TIME: '07:30',
    PROD_SHIFT_2_GRACE_MINUTES: '5',
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

  it('parses both production night shifts as crossing midnight', () => {
    assert.equal(parseHHMM('15:30', 'PROD_SHIFT_1_START_TIME'), '15:30');
    assert.equal(parseHHMM('03:30', 'PROD_SHIFT_1_END_TIME'), '03:30');
    assert.equal(computeCrossesMidnight('15:30', '03:30'), true);
    assert.equal(parseHHMM('19:30', 'PROD_SHIFT_2_START_TIME'), '19:30');
    assert.equal(parseHHMM('07:30', 'PROD_SHIFT_2_END_TIME'), '07:30');
    assert.equal(computeCrossesMidnight('19:30', '07:30'), true);
    assert.equal(computeCrossesMidnight('08:00', '17:00'), false);
  });

  it('rejects invalid HH:mm values', () => {
    assert.throws(() => parseHHMM('25:00', 'PROD_SHIFT_1_START_TIME'), BootstrapError);
    assert.throws(() => parseHHMM('18', 'PROD_SHIFT_1_START_TIME'), BootstrapError);
    assert.throws(() => parseHHMM('18:0', 'PROD_SHIFT_1_START_TIME'), BootstrapError);
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

  it('reads both night shifts from env without using a single PROD_SHIFT_* set', () => {
    const input = readBootstrapInput(validEnv());
    assert.equal(input.adminUsername, 'ops-admin');
    assert.equal(input.terminalSlug, 'riyadh-gate');
    assert.equal(input.shifts.length, 2);
    assert.equal(input.shifts[0].name, 'Night Shift 1');
    assert.equal(input.shifts[0].startTime, '15:30');
    assert.equal(input.shifts[0].endTime, '03:30');
    assert.equal(input.shifts[0].crossesMidnight, true);
    assert.equal(input.shifts[1].name, 'Night Shift 2');
    assert.equal(input.shifts[1].startTime, '19:30');
    assert.equal(input.shifts[1].endTime, '07:30');
    assert.equal(input.shifts[1].crossesMidnight, true);
    assert.ok('adminPassword' in input);
    assert.notEqual(input.adminPassword, 'admin123');
  });

  it('rejects duplicate shift names', () => {
    assert.throws(
      () =>
        readBootstrapInput(
          validEnv({
            PROD_SHIFT_2_NAME: 'Night Shift 1',
          })
        ),
      (err: unknown) => err instanceof BootstrapError && /must be different/.test(err.message)
    );
  });
});
