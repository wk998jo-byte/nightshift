export const BROWSER_DEVICE_ID_KEY = 'nightshift_device_id';

export type SimpleStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function createRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ns-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function defaultStorage(): SimpleStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Stable per-browser ID. No PII. Returns undefined if storage is unavailable. */
export function getBrowserDeviceId(storage?: SimpleStorage | null): string | undefined {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    if (!store) return undefined;
    const existing = store.getItem(BROWSER_DEVICE_ID_KEY)?.trim();
    if (existing && existing.length >= 8) return existing;
    const created = createRandomId();
    store.setItem(BROWSER_DEVICE_ID_KEY, created);
    return created;
  } catch {
    return undefined;
  }
}
