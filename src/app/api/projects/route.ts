import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET() {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['ADMIN', 'HR', 'SUPERVISOR', 'SECURITY'].includes(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const projects = await prisma.project.findMany({
    orderBy: { name: 'asc' },
    include: {
      terminals: { where: { isActive: true }, orderBy: { createdAt: 'asc' } },
      _count: { select: { assignments: true, attendance: true } },
    },
  });

  return NextResponse.json({ projects });
}
