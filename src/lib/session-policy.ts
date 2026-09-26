export const SESSION_COOKIE = 'ns_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;
export const SESSION_JWT_EXPIRATION = '24h';
export const LOGOUT_REDIRECT = '/login?loggedOut=1';
export const AUTH_NO_STORE = 'no-store';

export type SessionCookieBase = {
  httpOnly: true;
  path: '/';
  secure: boolean;
  sameSite: 'lax' | 'none';
  partitioned?: boolean;
};

export function authNoStoreHeaders(): { 'Cache-Control': string } {
  return { 'Cache-Control': AUTH_NO_STORE };
}

export function sessionSetCookieOptions(base: SessionCookieBase) {
  return {
    ...base,
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function sessionClearCookieOptions(base: SessionCookieBase) {
  return {
    ...base,
    maxAge: 0,
    expires: new Date(0),
  };
}

export type CookieWriter = {
  set: (name: string, value: string, options?: Record<string, unknown>) => unknown;
  delete: (input: unknown) => unknown;
};

/** Clear ns_session with the same path/flags as login, then overwrite with an expired cookie. */
export function clearSessionCookie(jar: CookieWriter, base: SessionCookieBase) {
  const deleteOpts: {
    name: string;
    path: '/';
    secure: boolean;
    sameSite: 'lax' | 'none';
    partitioned?: boolean;
  } = {
    name: SESSION_COOKIE,
    path: '/',
    secure: base.secure,
    sameSite: base.sameSite,
  };
  if (base.partitioned) deleteOpts.partitioned = true;
  jar.delete(deleteOpts);
  jar.set(SESSION_COOKIE, '', sessionClearCookieOptions(base));
}

export function isActiveAuthUser(user: { isActive: boolean } | null | undefined): boolean {
  return !!user && user.isActive === true;
}

export function meResponseUser<T extends { isActive: boolean }>(
  user: T | null | undefined
): T | null {
  return isActiveAuthUser(user) ? (user as T) : null;
}

export function shouldStayOnLoginAfterLogout(search: string): boolean {
  const q = search.startsWith('?') ? search.slice(1) : search;
  return new URLSearchParams(q).get('loggedOut') === '1';
}

export function loginLandingPath(
  user: { role: string } | null | undefined,
  search = ''
): '/app' | '/dashboard' | null {
  if (shouldStayOnLoginAfterLogout(search) || !user) return null;
  return user.role === 'EMPLOYEE' ? '/app' : '/dashboard';
}

export const SESSION_VERIFY_ERROR =
  'Session could not be established. Please reopen this page in Safari and try again.';

export function postLoginHardPath(role: string): '/app' | '/dashboard' {
  return role === 'EMPLOYEE' ? '/app' : '/dashboard';
}

export function employeeTodayFetchInit(): RequestInit {
  return { credentials: 'include', cache: 'no-store' };
}

export function todayNoStoreHeaders(): { 'Cache-Control': string } {
  return authNoStoreHeaders();
}

export type SessionVerifyResult =
  | { ok: true; path: '/app' | '/dashboard' }
  | { ok: false; error: string };

export async function completeAuthenticatedLogin(input: {
  role: string;
  verifyMe: () => Promise<{ user?: { role?: string } | null } | null>;
}): Promise<SessionVerifyResult> {
  try {
    const me = await input.verifyMe();
    if (!me?.user) return { ok: false, error: SESSION_VERIFY_ERROR };
    return { ok: true, path: postLoginHardPath(input.role) };
  } catch {
    return { ok: false, error: SESSION_VERIFY_ERROR };
  }
}

export function hardNavigateReplace(path: string) {
  window.location.replace(path);
}

export async function completeLogout(
  fetchLogout: () => Promise<{ ok: boolean }>
): Promise<{ ok: true; redirectTo: string } | { ok: false; error: string }> {
  try {
    const res = await fetchLogout();
    if (!res.ok) return { ok: false, error: 'Logout failed. Try again.' };
    return { ok: true, redirectTo: LOGOUT_REDIRECT };
  } catch {
    return { ok: false, error: 'Logout failed. Try again.' };
  }
}
