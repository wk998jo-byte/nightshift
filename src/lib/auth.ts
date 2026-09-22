import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { prisma } from './db';
import { SessionPayload, verifySession } from './security';
import { SESSION_COOKIE, isActiveAuthUser } from './session-policy';

export { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from './session-policy';

function requestHostname(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-host');
  const raw = (forwarded || req.headers.get('host') || req.nextUrl.hostname || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return raw.split(':')[0];
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isReplitDevHostname(hostname: string): boolean {
  return (
    hostname === 'replit.dev' ||
    hostname.endsWith('.replit.dev') ||
    hostname === 'repl.co' ||
    hostname.endsWith('.repl.co')
  );
}

/** Cookie flags for ns_session. No Domain attribute. SameSite=None only on Replit preview. */
export function sessionCookieOptions(req: NextRequest): {
  httpOnly: true;
  path: '/';
  secure: boolean;
  sameSite: 'lax' | 'none';
  partitioned?: boolean;
} {
  const hostname = requestHostname(req);

  if (isReplitDevHostname(hostname)) {
    return {
      httpOnly: true,
      path: '/',
      secure: true,
      sameSite: 'none',
      partitioned: true,
    };
  }

  if (isLocalHostname(hostname)) {
    return {
      httpOnly: true,
      path: '/',
      secure: false,
      sameSite: 'lax',
    };
  }

  return {
    httpOnly: true,
    path: '/',
    secure: true,
    sameSite: 'lax',
  };
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await verifySession(token);
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.sub },
    select: { isActive: true },
  });
  if (!isActiveAuthUser(user)) return null;
  return session;
}

export async function requireSession(roles?: string[]) {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHORIZED');
  if (roles && !roles.includes(session.role)) throw new Error('FORBIDDEN');
  return session;
}

export async function writeAudit(input: {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  employeeId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}) {
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId || null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      employeeId: input.employeeId,
      oldValue: input.oldValue != null ? JSON.stringify(input.oldValue) : null,
      newValue: input.newValue != null ? JSON.stringify(input.newValue) : null,
      ip: input.ip || null,
      userAgent: input.userAgent || null,
    },
  });
}
