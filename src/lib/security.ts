import { createHmac, randomBytes, createHash } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';

function requiredSecret(name: 'AUTH_SECRET' | 'QR_SECRET'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Create .env.local from .env.example and set a long random value. Refusing to use a hard-coded secret.`
    );
  }
  return value;
}

const authSecret = () => new TextEncoder().encode(requiredSecret('AUTH_SECRET'));

const qrSecret = () => requiredSecret('QR_SECRET');

export type SessionPayload = {
  sub: string;
  role: string;
  employeeId?: string | null;
  username: string;
};

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({
    role: payload.role,
    employeeId: payload.employeeId,
    username: payload.username,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(authSecret());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, authSecret());
    return {
      sub: String(payload.sub),
      role: String(payload.role),
      employeeId: (payload.employeeId as string) || null,
      username: String(payload.username),
    };
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createQrToken(input: {
  sessionId: string;
  projectId: string;
  terminalId: string;
  expiresAt: Date;
}): string {
  const body = Buffer.from(
    JSON.stringify({
      sid: input.sessionId,
      pid: input.projectId,
      tid: input.terminalId,
      exp: input.expiresAt.toISOString(),
      n: randomBytes(8).toString('hex'),
    })
  ).toString('base64url');
  const sig = createHmac('sha256', qrSecret()).update(body).digest('base64url');
  return `ns_v1.${body}.${sig}`;
}

export function verifyQrToken(token: string): {
  ok: boolean;
  sessionId?: string;
  projectId?: string;
  terminalId?: string;
  exp?: string;
  reason?: string;
} {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'ns_v1') {
    return { ok: false, reason: 'Invalid QR format' };
  }
  const [, body, sig] = parts;
  const expected = createHmac('sha256', qrSecret()).update(body).digest('base64url');
  if (expected !== sig) return { ok: false, reason: 'Invalid QR signature' };
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      sid: string;
      pid: string;
      tid: string;
      exp: string;
    };
    if (new Date(data.exp).getTime() < Date.now()) {
      return { ok: false, reason: 'Expired QR' };
    }
    return {
      ok: true,
      sessionId: data.sid,
      projectId: data.pid,
      terminalId: data.tid,
      exp: data.exp,
    };
  } catch {
    return { ok: false, reason: 'Corrupt QR' };
  }
}

export function fingerprintFromRequest(ua: string | null, extra?: string): string {
  return createHash('sha256')
    .update(`${ua || 'unknown'}|${extra || ''}`)
    .digest('hex')
    .slice(0, 32);
}
