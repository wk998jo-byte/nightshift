import type { QrSession } from '@prisma/client';
import type { QrErrorCode } from './qr-errors';
import { hashToken, verifyQrToken } from './security';

type SessionLookup = (id: string) => Promise<QrSession | null>;
type QrValidation =
  | { ok: true; projectId: string; session: QrSession }
  | { ok: false; error: string; code: QrErrorCode };

// Only QR errors belong here. GPS, authentication and shift policy stay in the punch routes.
export async function validatePunchQr(token: unknown, lookup: SessionLookup): Promise<QrValidation> {
  if (typeof token !== 'string' || !token) {
    return { ok: false, error: 'QR token required', code: 'QR_INVALID_FORMAT' };
  }
  const parsed = verifyQrToken(token);
  if (!parsed.ok || !parsed.sessionId || !parsed.projectId || !parsed.terminalId) {
    return { ok: false, error: parsed.reason || 'Invalid QR', code: parsed.code || 'QR_INVALID_FORMAT' };
  }
  const session = await lookup(parsed.sessionId);
  if (!session || session.revokedAt) {
    return { ok: false, error: 'QR session invalid', code: 'QR_SESSION_INVALID' };
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: 'Expired QR', code: 'QR_EXPIRED' };
  }
  if (session.tokenHash !== hashToken(token)
    || session.projectId !== parsed.projectId || session.terminalId !== parsed.terminalId) {
    return { ok: false, error: 'QR mismatch', code: 'QR_MISMATCH' };
  }
  return { ok: true, projectId: parsed.projectId, session };
}
