import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import type { QrSession } from '@prisma/client';
import { createQrToken, hashToken, verifyQrToken } from './security';
import { expiredQrSessions, qrDeadlines, QR_SCAN_GRACE_SECONDS } from './qr-lifecycle';
import { validatePunchQr } from './qr-validation';
import { formatDuration } from './attendance-calc';
import { readFileSync } from 'node:fs';
import { isInsideRadius } from './geo';

// An isolated test-only key, never read from workspace secrets.
const testKey = 'isolated-qr-reliability-unit-test-key';
process.env.QR_SECRET = testKey;

function issue(id: string, issuedAt: Date, rotation = 30) {
  const deadlines = qrDeadlines(issuedAt, rotation);
  const token = createQrToken({ sessionId: id, projectId: 'project', terminalId: 'terminal', ...deadlines });
  const session: QrSession = {
    id, projectId: 'project', terminalId: 'terminal', issuedAt,
    expiresAt: deadlines.expiresAt, revokedAt: null, tokenHash: hashToken(token),
  };
  return { token, session, ...deadlines };
}

test('configured rotation and centralized 60-second scan grace are separate deadlines', () => {
  assert.equal(QR_SCAN_GRACE_SECONDS, 60);
  const now = new Date('2026-10-13T00:00:00Z');
  for (const rotation of [15, 30, 45]) {
    const { rotatesAt, expiresAt } = qrDeadlines(now, rotation);
    assert.equal(rotatesAt.getTime() - now.getTime(), rotation * 1000);
    assert.equal(expiresAt.getTime() - rotatesAt.getTime(), 60000);
  }
});

test('old scans survive rotation, multiple terminal tabs, and GPS delay; expiry is strict', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T00:00:00Z').getTime() });
  const sessions = new Map<string, QrSession>();
  const first = issue('first', new Date());
  sessions.set(first.session.id, first.session);
  const lookup = async (id: string) => sessions.get(id) ?? null;
  t.mock.timers.tick(30000);
  const second = issue('second-tab', new Date());
  sessions.set(second.session.id, second.session);
  const third = issue('third-tab', new Date());
  sessions.set(third.session.id, third.session);
  const filter = expiredQrSessions('terminal', new Date());
  for (const session of sessions.values()) {
    if (session.terminalId === filter.terminalId && !session.revokedAt
      && session.expiresAt <= filter.expiresAt.lte) session.revokedAt = new Date();
  }
  t.mock.timers.tick(59000);
  for (const issued of [first, second, third]) {
    assert.equal((await validatePunchQr(issued.token, lookup)).ok, true);
  }
  t.mock.timers.tick(1000);
  assert.deepEqual(await validatePunchQr(first.token, lookup), {
    ok: false, error: 'Expired QR', code: 'QR_EXPIRED',
  });
  assert.equal((await validatePunchQr(second.token, lookup)).ok, true);
  assert.equal(first.session.revokedAt, null);
});

test('cleanup touches only expired sessions for that terminal', () => {
  const now = new Date();
  assert.deepEqual(expiredQrSessions('terminal', now), {
    terminalId: 'terminal', revokedAt: null, expiresAt: { lte: now },
  });
});

test('QR validation rejects malformed, unsigned, expired, revoked, hash and binding failures without leaks', async () => {
  const issued = issue('valid', new Date());
  const lookup = async () => issued.session;
  const cases: Array<[unknown, QrSession | null, string]> = [
    ['', issued.session, 'QR_INVALID_FORMAT'],
    [123, issued.session, 'QR_INVALID_FORMAT'],
    ['not-a-token', issued.session, 'QR_INVALID_FORMAT'],
    [issued.token + 'tampered', issued.session, 'QR_INVALID_SIGNATURE'],
    [issued.token, null, 'QR_SESSION_INVALID'],
    [issued.token, { ...issued.session, revokedAt: new Date() }, 'QR_SESSION_INVALID'],
    [issued.token, { ...issued.session, expiresAt: new Date(0) }, 'QR_EXPIRED'],
    [issued.token, { ...issued.session, tokenHash: 'different' }, 'QR_MISMATCH'],
    [issued.token, { ...issued.session, projectId: 'other' }, 'QR_MISMATCH'],
    [issued.token, { ...issued.session, terminalId: 'other' }, 'QR_MISMATCH'],
  ];
  for (const [token, session, code] of cases) {
    const result = await validatePunchQr(token, async () => session);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, code);
    const serialized = JSON.stringify(result);
    for (const sensitive of [issued.token, issued.session.tokenHash, testKey]) {
      assert.equal(serialized.includes(sensitive), false);
    }
  }
  assert.equal((await validatePunchQr(issued.token, lookup)).ok, true);
  const expired = issue('expired', new Date(Date.now() - 91000));
  assert.equal(verifyQrToken(expired.token).code, 'QR_EXPIRED');
});

test('correct signatures cannot bypass malformed payload validation', () => {
  for (const payload of ['{', JSON.stringify({ sid: 's', pid: 'p', tid: 't', exp: 'invalid' }), '{}']) {
    const body = Buffer.from(payload).toString('base64url');
    const signature = createHmac('sha256', testKey).update(body).digest('base64url');
    assert.equal(verifyQrToken(`ns_v1.${body}.${signature}`).code, 'QR_INVALID_FORMAT');
  }
});

test('duration presentation preserves zero, minutes padding and unknown OT', () => {
  assert.equal(formatDuration(244), '4h 04m');
  assert.equal(formatDuration(220), '3h 40m');
  assert.equal(formatDuration(92), '1h 32m');
  assert.equal(formatDuration(0), '0h 00m');
  assert.equal(formatDuration(60), '1h 00m');
  assert.equal(formatDuration(null), '—');
});

test('GPS radius continues rejecting coordinates outside the work site', () => {
  assert.equal(isInsideRadius(24.7, 46.7, 24.7, 46.7, 100).inside, true);
  assert.equal(isInsideRadius(24.71, 46.71, 24.7, 46.7, 100).inside, false);
});

test('terminal route issues overlapping sessions and cleans up only expired sessions with a mocked database', async () => {
  const sessions = new Map<string, QrSession>();
  let now = new Date();
  const terminal = {
    id: 'terminal', slug: 'fixture', projectId: 'project', rotationSeconds: 30,
    isActive: true, name: 'Fixture gate',
    project: { isActive: true, name: 'Fixture site', code: 'FIXTURE', locationLabel: 'Fixture' },
  };
  const expired = issue('old-expired', new Date(now.getTime() - 91000)).session;
  sessions.set(expired.id, expired);
  const other = { ...expired, id: 'other-terminal', terminalId: 'other' };
  sessions.set(other.id, other);
  const mockDb = {
    qrTerminal: { findUnique: async () => terminal, update: async () => terminal },
    qrSession: {
      updateMany: async ({ where, data }: {
        where: ReturnType<typeof expiredQrSessions>; data: { revokedAt: Date };
      }) => {
        for (const session of sessions.values()) {
          if (session.terminalId === where.terminalId && session.revokedAt === null
            && session.expiresAt <= where.expiresAt.lte) session.revokedAt = data.revokedAt;
        }
      },
      create: async ({ data }: { data: Omit<QrSession, 'revokedAt'> }) => {
        sessions.set(data.id, { ...data, revokedAt: null });
        return data;
      },
    },
  };
  const globalDb = globalThis as unknown as { prisma?: unknown };
  globalDb.prisma = mockDb;
  const { POST } = await import('../app/api/terminal/[slug]/route');
  const { NextRequest } = await import('next/server');
  try {
    const rotate = () => POST(new NextRequest('http://fixture.test/api/terminal/fixture', {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin' },
    }), { params: Promise.resolve({ slug: 'fixture' }) });
    const first = await (await rotate()).json();
    const second = await (await rotate()).json();
    assert.equal(first.rotationSeconds, 30);
    assert.equal(new Date(first.expiresAt).getTime() - new Date(first.rotatesAt).getTime(), 60000);
    const lookup = async (id: string) => sessions.get(id) ?? null;
    assert.equal((await validatePunchQr(first.token, lookup)).ok, true);
    assert.equal((await validatePunchQr(second.token, lookup)).ok, true);
    assert.ok(expired.revokedAt);
    assert.equal(other.revokedAt, null);
    const denied = await POST(new NextRequest('http://fixture.test/api/terminal/fixture', {
      method: 'POST', headers: { origin: 'http://foreign.test', 'sec-fetch-site': 'cross-site' },
    }), { params: Promise.resolve({ slug: 'fixture' }) });
    assert.equal(denied.status, 403);
  } finally {
    delete globalDb.prisma;
  }
});

test('both punch routes keep authentication, GPS and business policy outside QR recovery', () => {
  for (const action of ['check-in', 'check-out']) {
    const source = readFileSync(`src/app/api/attendance/${action}/route.ts`, 'utf8');
    assert.ok(source.indexOf('await getSession()') < source.indexOf('const body ='));
    assert.match(source, /!auth \|\| !auth\.employeeId/);
    assert.match(source, /status: 401/);
    assert.match(source, /latitude == null \|\|.*longitude == null/);
    assert.match(source, /validatePunchQr/);
    assert.match(source, /isInsideRadius/);
    assert.match(source, /status: 403/);
  }
  const checkIn = readFileSync('src/app/api/attendance/check-in/route.ts', 'utf8');
  assert.match(checkIn, /evaluateLiveCheckIn/);
  assert.match(checkIn, /NO_SCHEDULE/);
  assert.match(checkIn, /assignment\.projectId !== project\.id/);
  const checkOut = readFileSync('src/app/api/attendance/check-out/route.ts', 'utf8');
  assert.match(checkOut, /resolveCheckoutTarget/);
  assert.match(checkOut, /STALE_MISSING_CHECKOUT/);
  assert.match(checkOut, /open\.projectId !== qr\.projectId/);
  const terminal = readFileSync('src/app/terminal/[slug]/page.tsx', 'utf8');
  assert.match(terminal, /new Date\(data\.rotatesAt\)\.getTime\(\) - Date\.now\(\)/);
  assert.match(terminal, /rotatesAt\.getTime\(\) - now\.getTime\(\)/);
  assert.equal(terminal.includes('data.expiresAt'), false);
});
