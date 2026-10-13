export const QR_SCAN_GRACE_SECONDS = 60;

export function qrDeadlines(issuedAt: Date, rotationSeconds: number) {
  const rotatesAt = new Date(issuedAt.getTime() + rotationSeconds * 1000);
  const expiresAt = new Date(rotatesAt.getTime() + QR_SCAN_GRACE_SECONDS * 1000);
  return { rotatesAt, expiresAt };
}

export function expiredQrSessions(terminalId: string, now: Date) {
  return { terminalId, revokedAt: null, expiresAt: { lte: now } };
}
