/** Short ID for admins. Derived from fingerprint; never show the full hash to users. */
export function displayDeviceId(fingerprint: string | null | undefined): string {
  const hex = (fingerprint || '').replace(/[^a-fA-F0-9]/g, '').slice(0, 8).toUpperCase();
  if (!hex) return '—';
  return `DEV-${hex.padEnd(8, '0')}`;
}

/** Coarse OS · browser label from User-Agent. Does not claim a personal device name. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua || !ua.trim()) return '—';
  const os = /iPhone|iPod/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /FxiOS|Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari/.test(ua)
            ? 'Safari'
            : 'Browser';
  return `${os} · ${browser}`;
}

export function dash(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  return String(value);
}

export function formatGps(
  lat: number | null | undefined,
  lng: number | null | undefined
): string {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return '—';
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export function punchMapUrl(
  lat: number | null | undefined,
  lng: number | null | undefined
): string | null {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}
