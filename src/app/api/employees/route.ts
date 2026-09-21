import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const code = req.nextUrl.searchParams.get('code');
  if (code) {
    if (!['ADMIN', 'HR', 'SUPERVISOR'].includes(auth.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const employee = await prisma.employee.findFirst({
      where: { OR: [{ employeeCode: code }, { badgeNumber: code }] },
    });
    return NextResponse.json({ employee });
  }

  if (!['ADMIN', 'HR', 'SUPERVISOR'].includes(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const employees = await prisma.employee.findMany({
    orderBy: { fullName: 'asc' },
    include: {
      defaultProject: true,
      user: { select: { role: true, username: true, isActive: true } },
    },
  });

  return NextResponse.json({ employees });
}
