import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { SESSION_COOKIE, sessionCookieOptions, writeAudit } from '@/lib/auth';
import { signSession } from '@/lib/security';
import { authNoStoreHeaders, sessionSetCookieOptions } from '@/lib/session-policy';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  if (!username || !password) {
    return NextResponse.json(
      { error: 'Username and password required' },
      { status: 400, headers: authNoStoreHeaders() }
    );
  }

  const user = await prisma.user.findUnique({
    where: { username },
    include: { employee: true },
  });
  if (!user || !user.isActive) {
    return NextResponse.json(
      { error: 'Invalid credentials' },
      { status: 401, headers: authNoStoreHeaders() }
    );
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: 'Invalid credentials' },
      { status: 401, headers: authNoStoreHeaders() }
    );
  }

  const token = await signSession({
    sub: user.id,
    role: user.role,
    employeeId: user.employeeId,
    username: user.username,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await writeAudit({
    actorId: user.id,
    action: 'LOGIN',
    entityType: 'User',
    entityId: user.id,
    employeeId: user.employeeId || undefined,
    ip: req.headers.get('x-forwarded-for'),
    userAgent: req.headers.get('user-agent'),
  });

  const res = NextResponse.json(
    {
      ok: true,
      role: user.role,
      username: user.username,
      employee: user.employee
        ? {
            id: user.employee.id,
            fullName: user.employee.fullName,
            employeeCode: user.employee.employeeCode,
          }
        : null,
    },
    { headers: authNoStoreHeaders() }
  );

  res.cookies.set(SESSION_COOKIE, token, sessionSetCookieOptions(sessionCookieOptions(req)));

  return res;
}
