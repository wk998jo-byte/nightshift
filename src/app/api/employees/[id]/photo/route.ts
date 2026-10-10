import { NextRequest, NextResponse } from 'next/server';
import { getSession, writeAudit } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canManagePeople, canViewPeople } from '@/lib/employee-management';
import { normalizeEmployeePhoto, validateEmployeePhotoUpload } from '@/lib/employee-photo';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewPeople(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const photo = await prisma.employeePhoto.findUnique({ where: { employeeId: id } });
  if (!photo) return new NextResponse(null, { status: 404 });

  const etag = `"${photo.updatedAt.getTime()}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  return new NextResponse(Buffer.from(photo.data), {
    headers: {
      'Content-Type': photo.mimeType,
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
    },
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManagePeople(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const employee = await prisma.employee.findUnique({ where: { id }, select: { id: true, fullName: true, employeeCode: true } });
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

  const buffer = Buffer.from(await req.arrayBuffer());
  const valid = validateEmployeePhotoUpload(buffer);
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: valid.status });

  const normalized = await normalizeEmployeePhoto(buffer);
  const bytes = new Uint8Array(normalized.data);
  await prisma.employeePhoto.upsert({
    where: { employeeId: id },
    create: { employeeId: id, data: bytes, mimeType: normalized.mimeType },
    update: { data: bytes, mimeType: normalized.mimeType },
  });

  await writeAudit({
    actorId: auth.sub,
    action: 'EMPLOYEE_PHOTO_UPDATED',
    entityType: 'Employee',
    entityId: id,
    employeeId: id,
    newValue: {
      employeeId: id,
      employeeCode: employee.employeeCode,
      employeeName: employee.fullName,
      mimeType: normalized.mimeType,
    },
  });

  return NextResponse.json({ ok: true, mimeType: normalized.mimeType });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManagePeople(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const employee = await prisma.employee.findUnique({ where: { id }, select: { id: true, fullName: true, employeeCode: true } });
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

  await prisma.employeePhoto.deleteMany({ where: { employeeId: id } });
  await writeAudit({
    actorId: auth.sub,
    action: 'EMPLOYEE_PHOTO_REMOVED',
    entityType: 'Employee',
    entityId: id,
    employeeId: id,
    newValue: {
      employeeId: id,
      employeeCode: employee.employeeCode,
      employeeName: employee.fullName,
    },
  });
  return NextResponse.json({ ok: true });
}
