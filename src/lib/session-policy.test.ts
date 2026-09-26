import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUTH_NO_STORE,
  LOGOUT_REDIRECT,
  SESSION_COOKIE,
  SESSION_JWT_EXPIRATION,
  SESSION_MAX_AGE_SECONDS,
  SESSION_VERIFY_ERROR,
  authNoStoreHeaders,
  clearSessionCookie,
  completeAuthenticatedLogin,
  completeLogout,
  employeeTodayFetchInit,
  isActiveAuthUser,
  loginLandingPath,
  meResponseUser,
  postLoginHardPath,
  sessionClearCookieOptions,
  sessionSetCookieOptions,
  shouldStayOnLoginAfterLogout,
  todayNoStoreHeaders,
  type CookieWriter,
  type SessionCookieBase,
} from './session-policy';
import { signSession } from './security';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-auth-secret-for-session-policy-32';
process.env.QR_SECRET = process.env.QR_SECRET || 'test-qr-secret-for-session-policy-32abc';

const cookieBase: SessionCookieBase = {
  httpOnly: true,
  path: '/',
  secure: true,
  sameSite: 'lax',
};

function cookieJar(): CookieWriter & {
  setCalls: Array<{ name: string; value: string; options?: Record<string, unknown> }>;
  deleteCalls: unknown[];
} {
  const setCalls: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
  const deleteCalls: unknown[] = [];
  return {
    setCalls,
    deleteCalls,
    set(name, value, options) {
      setCalls.push({ name, value, options });
    },
    delete(input) {
      deleteCalls.push(input);
    },
  };
}

describe('session lifetime', () => {
  it('session lifetime is 24 hours for cookie and JWT', async () => {
    assert.equal(SESSION_MAX_AGE_SECONDS, 60 * 60 * 24);
    assert.equal(SESSION_JWT_EXPIRATION, '24h');
    const setOpts = sessionSetCookieOptions(cookieBase);
    assert.equal(setOpts.maxAge, 86400);
    assert.equal(setOpts.path, '/');
    const token = await signSession({
      sub: 'user-1',
      role: 'EMPLOYEE',
      employeeId: 'emp-1',
      username: '71326',
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
      iat: number;
      exp: number;
    };
    assert.equal(payload.exp - payload.iat, SESSION_MAX_AGE_SECONDS);
  });

  it('successful login creates ns_session with 24h maxAge', () => {
    const opts = sessionSetCookieOptions(cookieBase);
    assert.equal(SESSION_COOKIE, 'ns_session');
    assert.equal(opts.maxAge, SESSION_MAX_AGE_SECONDS);
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.path, '/');
  });
});

describe('logout cookie clearing', () => {
  it('logout expires and deletes ns_session with the same path as login', () => {
    const jar = cookieJar();
    clearSessionCookie(jar, cookieBase);
    assert.equal(jar.deleteCalls.length, 1);
    assert.deepEqual(jar.deleteCalls[0], {
      name: SESSION_COOKIE,
      path: '/',
      secure: true,
      sameSite: 'lax',
    });
    const cleared = jar.setCalls[0];
    assert.equal(cleared.name, SESSION_COOKIE);
    assert.equal(cleared.value, '');
    assert.equal(cleared.options?.maxAge, 0);
    assert.equal((cleared.options?.expires as Date).getTime(), 0);
    assert.equal(cleared.options?.path, '/');
    const clearOpts = sessionClearCookieOptions(cookieBase);
    assert.equal(clearOpts.maxAge, 0);
    assert.equal(clearOpts.expires.getTime(), 0);
  });

  it('/api/auth/me after logout returns no authenticated user', () => {
    assert.equal(meResponseUser(null), null);
    assert.deepEqual(isActiveAuthUser(undefined), false);
  });
});

describe('active user validation', () => {
  it('inactive user returns user:null', () => {
    assert.equal(isActiveAuthUser({ isActive: false }), false);
    assert.equal(meResponseUser({ isActive: false, id: 'u1' }), null);
    assert.equal(isActiveAuthUser(null), false);
    assert.ok(meResponseUser({ isActive: true, id: 'u2' }));
  });
});

describe('logout navigation', () => {
  it('logout from employee app hard redirects to login', async () => {
    const result = await completeLogout(async () => ({ ok: true }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.redirectTo, '/login?loggedOut=1');
      assert.equal(result.redirectTo, LOGOUT_REDIRECT);
    }
  });

  it('logout from dashboard hard redirects to login', async () => {
    const result = await completeLogout(async () => ({ ok: true }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.redirectTo, LOGOUT_REDIRECT);
  });

  it('failed logout does not pretend success', async () => {
    const failed = await completeLogout(async () => ({ ok: false }));
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.error, /Logout failed/);
    const threw = await completeLogout(async () => {
      throw new Error('network');
    });
    assert.equal(threw.ok, false);
  });
});

describe('login auto-enter', () => {
  it('normal valid session still auto-enters the correct app before logout', () => {
    assert.equal(loginLandingPath({ role: 'EMPLOYEE' }), '/app');
    assert.equal(loginLandingPath({ role: 'ADMIN' }), '/dashboard');
    assert.equal(loginLandingPath({ role: 'HR' }), '/dashboard');
    assert.equal(loginLandingPath(null), null);
  });

  it('loggedOut=1 stays on the login screen', () => {
    assert.equal(shouldStayOnLoginAfterLogout('?loggedOut=1'), true);
    assert.equal(loginLandingPath({ role: 'EMPLOYEE' }, '?loggedOut=1'), null);
    assert.equal(loginLandingPath({ role: 'ADMIN' }, 'loggedOut=1'), null);
    assert.equal(shouldStayOnLoginAfterLogout(''), false);
  });

  it('auth endpoints use Cache-Control no-store', () => {
    assert.deepEqual(authNoStoreHeaders(), { 'Cache-Control': AUTH_NO_STORE });
    assert.deepEqual(todayNoStoreHeaders(), { 'Cache-Control': 'no-store' });
  });
});

describe('post-login hard navigation', () => {
  it('successful employee login uses hard /app navigation', async () => {
    assert.equal(postLoginHardPath('EMPLOYEE'), '/app');
    const result = await completeAuthenticatedLogin({
      role: 'EMPLOYEE',
      verifyMe: async () => ({ user: { role: 'EMPLOYEE' } }),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.path, '/app');
  });

  it('successful admin login uses hard /dashboard navigation', async () => {
    assert.equal(postLoginHardPath('ADMIN'), '/dashboard');
    const result = await completeAuthenticatedLogin({
      role: 'ADMIN',
      verifyMe: async () => ({ user: { role: 'ADMIN' } }),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.path, '/dashboard');
  });

  it('post-login /api/auth/me verification is required', async () => {
    let verified = false;
    await completeAuthenticatedLogin({
      role: 'EMPLOYEE',
      verifyMe: async () => {
        verified = true;
        return { user: { role: 'EMPLOYEE' } };
      },
    });
    assert.equal(verified, true);
  });

  it('failed session verification stays on login with error', async () => {
    const missing = await completeAuthenticatedLogin({
      role: 'EMPLOYEE',
      verifyMe: async () => ({ user: null }),
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error, SESSION_VERIFY_ERROR);
    const failed = await completeAuthenticatedLogin({
      role: 'EMPLOYEE',
      verifyMe: async () => {
        throw new Error('network');
      },
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.error, /Safari/);
  });

  it('/api/me/today fetch uses credentials include + no-store', () => {
    assert.deepEqual(employeeTodayFetchInit(), { credentials: 'include', cache: 'no-store' });
  });
});
