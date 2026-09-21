import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null });

  const user = await prisma.user.findUnique({
    where: { id: session.sub },
    include: { employee: true },
  });

  return NextResponse.json({
    user: user
      ? {
          id: user.id,
          username: user.username,
          role: user.role,
          employee: user.employee,
        }
      : null,
  });
}
