import { cookies } from 'next/headers';
import { prisma } from './db';
import { SessionPayload, verifySession } from './security';

export const SESSION_COOKIE = 'ns_session';

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
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
