import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { authNoStoreHeaders, meResponseUser } from '@/lib/session-policy';

export async function GET() {
  const headers = authNoStoreHeaders();
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null }, { headers });

  const user = await prisma.user.findUnique({
    where: { id: session.sub },
    include: { employee: true },
  });
  const active = meResponseUser(user);
  if (!active) return NextResponse.json({ user: null }, { headers });

  return NextResponse.json(
    {
      user: {
        id: active.id,
        username: active.username,
        role: active.role,
        employee: active.employee,
      },
    },
    { headers }
  );
}
