import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  attachSupervisors,
  canManagePeople,
  canViewPeople,
  parseEmployeeUpdate,
  toPublicEmployee,
  updateManagedEmployee,
} from '@/lib/employee-management';

async function loadPublicEmployee(id: string) {
  const employee = await prisma.employee.findUnique({
    where: { id },
    include: {
      defaultProject: { select: { id: true, name: true, code: true } },
      user: { select: { role: true, username: true, isActive: true } },
      photo: { select: { updatedAt: true } },
    },
  });
  if (!employee) return null;
  const supervisors = await attachSupervisors(prisma, [employee]);
  return toPublicEmployee({
    ...employee,
    supervisor: employee.supervisorId ? supervisors.get(employee.supervisorId) || null : null,
  });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewPeople(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const employee = await loadPublicEmployee(id);
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
  return NextResponse.json({ employee });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManagePeople(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = parseEmployeeUpdate(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const result = await updateManagedEmployee({
    db: prisma,
    actorId: auth.sub,
    employeeId: id,
    data: parsed.data,
    writeAudit,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const employee = (await loadPublicEmployee(id)) || result.employee;
  return NextResponse.json({ employee });
}
