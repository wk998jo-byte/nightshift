import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { createQrToken, hashToken } from '@/lib/security';
import { randomUUID } from 'crypto';

function isSameAppRequest(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site === 'same-origin' || site === 'same-site') return true;

  const requestHostname = req.nextUrl.hostname.toLowerCase();
  for (const header of ['origin', 'referer'] as const) {
    const value = req.headers.get(header);
    if (!value) continue;
    try {
      if (new URL(value).hostname.toLowerCase() === requestHostname) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;
  if (!isSameAppRequest(req)) {
    return NextResponse.json({ error: 'Terminal rotate must come from the app' }, { status: 403 });
  }

  const terminal = await prisma.qrTerminal.findUnique({
    where: { slug },
    include: { project: true },
  });

  if (!terminal || !terminal.isActive || !terminal.project.isActive) {
    return NextResponse.json({ error: 'Terminal not found' }, { status: 404 });
  }

  const rotation = terminal.rotationSeconds || 30;
  const expiresAt = new Date(Date.now() + rotation * 1000);
  const sessionId = randomUUID();
  const token = createQrToken({
    sessionId,
    projectId: terminal.projectId,
    terminalId: terminal.id,
    expiresAt,
  });

  await prisma.qrSession.updateMany({
    where: { terminalId: terminal.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await prisma.qrSession.create({
    data: {
      id: sessionId,
      terminalId: terminal.id,
      projectId: terminal.projectId,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  await prisma.qrTerminal.update({
    where: { id: terminal.id },
    data: { lastSeenAt: new Date() },
  });

  return NextResponse.json({
    token,
    expiresAt: expiresAt.toISOString(),
    rotationSeconds: rotation,
    project: {
      name: terminal.project.name,
      code: terminal.project.code,
      locationLabel: terminal.project.locationLabel,
    },
    terminalName: terminal.name,
  });
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;
  const terminal = await prisma.qrTerminal.findUnique({
    where: { slug },
    include: { project: true },
  });
  if (!terminal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    slug: terminal.slug,
    name: terminal.name,
    rotationSeconds: terminal.rotationSeconds,
    project: {
      name: terminal.project.name,
      code: terminal.project.code,
      locationLabel: terminal.project.locationLabel,
    },
  });
}
