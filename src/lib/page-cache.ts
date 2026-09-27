export const HTML_APP_ROUTE_SOURCES = ['/', '/login', '/app', '/dashboard', '/terminal/:path*'] as const;

export const HTML_APP_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, max-age=0';

export const HTML_APP_CACHE_HEADERS = [
  { key: 'Cache-Control', value: HTML_APP_CACHE_CONTROL },
  { key: 'Pragma', value: 'no-cache' },
  { key: 'Expires', value: '0' },
] as const;

export function nextHtmlAppCacheHeaders(): Array<{
  source: string;
  headers: Array<{ key: string; value: string }>;
}> {
  return HTML_APP_ROUTE_SOURCES.map((source) => ({
    source,
    headers: HTML_APP_CACHE_HEADERS.map((h) => ({ key: h.key, value: h.value })),
  }));
}

export function isHashedNextStaticAsset(path: string): boolean {
  return path.startsWith('/_next/static/');
}

function matchHtmlAppRoute(path: string): boolean {
  if (path === '/' || path === '/login' || path === '/app' || path === '/dashboard') return true;
  return path === '/terminal' || path.startsWith('/terminal/');
}

export function cacheHeadersForPath(path: string): Array<{ key: string; value: string }> | null {
  if (isHashedNextStaticAsset(path)) return null;
  if (!matchHtmlAppRoute(path)) return null;
  return HTML_APP_CACHE_HEADERS.map((h) => ({ key: h.key, value: h.value }));
}

export function shouldReloadOnPageshow(event: { persisted?: boolean }): boolean {
  return event.persisted === true;
}

export function runPersistedPageshowReload(
  event: { persisted?: boolean },
  reload: () => void
): boolean {
  if (!shouldReloadOnPageshow(event)) return false;
  reload();
  return true;
}

export function dashboardLiveFetchInit(): RequestInit {
  return { credentials: 'include', cache: 'no-store' };
}

export function operationalApiFetchInit(): RequestInit {
  return { credentials: 'include', cache: 'no-store' };
}
