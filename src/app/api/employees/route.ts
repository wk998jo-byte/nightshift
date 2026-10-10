import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { listExportableEmployees } from '@/lib/attendance-export';
import {
  PEOPLE_EMPLOYEE_WHERE,
  attachSupervisors,
  canManagePeople,
  canViewPeople,
  createManagedEmployee,
  includePeopleEmployee,
  parseEmployeeCreate,
  toPublicEmployee,
} from '@/lib/employee-management';
import { SHIFT_SCHEDULE_EMPLOYEE_WHERE } from '@/lib/shift-catalog';

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

  if (!canViewPeople(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (req.nextUrl.searchParams.get('scope') === 'export') {
    const employees = await prisma.employee.findMany({
      orderBy: { fullName: 'asc' },
      include: {
        defaultProject: true,
        user: { select: { role: true, username: true, isActive: true } },
      },
    });
    return NextResponse.json({ employees: listExportableEmployees(employees) });
  }

  const activeOnly = req.nextUrl.searchParams.get('activeOnly') !== '0';
  const employees = await prisma.employee.findMany({
    where: activeOnly ? SHIFT_SCHEDULE_EMPLOYEE_WHERE : PEOPLE_EMPLOYEE_WHERE,
    orderBy: { fullName: 'asc' },
    include: {
      defaultProject: { select: { id: true, name: true, code: true } },
      user: { select: { role: true, username: true, isActive: true } },
      photo: { select: { updatedAt: true } },
    },
  });
  const supervisors = await attachSupervisors(prisma, employees);
  const publicEmployees = employees
    .filter((row) => includePeopleEmployee(row))
    .map((row) =>
      toPublicEmployee({
        ...row,
        supervisor: row.supervisorId ? supervisors.get(row.supervisorId) || null : null,
      })
    );

  return NextResponse.json({ employees: publicEmployees });
}

export async function POST(req: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManagePeople(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = parseEmployeeCreate(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const result = await createManagedEmployee({
    db: prisma,
    actorId: auth.sub,
    data: parsed.data,
    writeAudit,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ employee: result.employee }, { status: 201 });
}
