import sharp from 'sharp';

export const MAX_EMPLOYEE_PHOTO_BYTES = 2 * 1024 * 1024;
export const EMPLOYEE_PHOTO_SIZE = 512;
export const EMPLOYEE_PHOTO_MIME = 'image/webp';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PhotoValidation =
  | { ok: true; kind: 'jpeg' | 'png' | 'webp' }
  | { ok: false; error: string; status: number };

function startsWith(buffer: Buffer, magic: Buffer): boolean {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

function looksLikeSvgOrHtml(buffer: Buffer): boolean {
  const head = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').trim().toLowerCase();
  return (
    head.startsWith('<svg') ||
    head.includes('<svg') ||
    head.startsWith('<?xml') ||
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<script')
  );
}

export function detectAllowedImageKind(buffer: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (!buffer?.length) return null;
  if (looksLikeSvgOrHtml(buffer)) return null;
  if (startsWith(buffer, JPEG_MAGIC)) return 'jpeg';
  if (startsWith(buffer, PNG_MAGIC)) return 'png';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export function validateEmployeePhotoUpload(buffer: Buffer): PhotoValidation {
  if (!buffer?.length) return { ok: false, error: 'Photo is required', status: 400 };
  if (buffer.length > MAX_EMPLOYEE_PHOTO_BYTES) {
    return { ok: false, error: 'Photo must be 2 MB or smaller', status: 400 };
  }
  const kind = detectAllowedImageKind(buffer);
  if (!kind) return { ok: false, error: 'Photo must be a JPEG, PNG, or WebP image', status: 400 };
  return { ok: true, kind };
}

export async function normalizeEmployeePhoto(buffer: Buffer): Promise<{
  data: Buffer;
  mimeType: typeof EMPLOYEE_PHOTO_MIME;
}> {
  const data = await sharp(buffer)
    .rotate()
    .resize(EMPLOYEE_PHOTO_SIZE, EMPLOYEE_PHOTO_SIZE, {
      fit: 'cover',
      position: 'attention',
    })
    .webp({ quality: 82 })
    .toBuffer();
  return { data, mimeType: EMPLOYEE_PHOTO_MIME };
}
