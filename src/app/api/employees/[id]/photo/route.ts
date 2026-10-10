import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  canManagePeople,
  canViewPeople,
  removeManagedEmployeePhoto,
  replaceManagedEmployeePhoto,
} from '@/lib/employee-management';
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
  const buffer = Buffer.from(await req.arrayBuffer());
  const valid = validateEmployeePhotoUpload(buffer);
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: valid.status });

  const normalized = await normalizeEmployeePhoto(buffer);
  const result = await replaceManagedEmployeePhoto({
    db: prisma,
    actorId: auth.sub,
    employeeId: id,
    data: new Uint8Array(normalized.data),
    mimeType: normalized.mimeType,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, mimeType: result.mimeType });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManagePeople(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const result = await removeManagedEmployeePhoto({
    db: prisma,
    actorId: auth.sub,
    employeeId: id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
