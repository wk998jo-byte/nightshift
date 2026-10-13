export type QrErrorCode =
  | 'QR_INVALID_FORMAT'
  | 'QR_INVALID_SIGNATURE'
  | 'QR_EXPIRED'
  | 'QR_SESSION_INVALID'
  | 'QR_MISMATCH';

export const QR_RESCAN_MESSAGE = 'QR changed or expired. Scan the current code again.';

export function isRecoverableQrError(code: unknown): code is QrErrorCode {
  return typeof code === 'string' && [
    'QR_INVALID_FORMAT', 'QR_INVALID_SIGNATURE', 'QR_EXPIRED',
    'QR_SESSION_INVALID', 'QR_MISMATCH',
  ].includes(code);
}
