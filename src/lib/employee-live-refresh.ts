// Mobile browsers can suspend polling in the background. Coalesce foreground events.
export function subscribeEmployeeForegroundRefresh(
  target: EventTarget,
  documentTarget: EventTarget,
  isVisible: () => boolean,
  refresh: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRefresh = 0;
  const schedule = (event: Event) => {
    if (!isVisible() || ('persisted' in event && event.persisted)) return;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!isVisible()) return;
      lastRefresh = Date.now();
      refresh();
    }, Math.max(250, 1000 - (Date.now() - lastRefresh)));
  };
  target.addEventListener('focus', schedule);
  target.addEventListener('pageshow', schedule);
  documentTarget.addEventListener('visibilitychange', schedule);
  return () => {
    clearTimeout(timer);
    target.removeEventListener('focus', schedule);
    target.removeEventListener('pageshow', schedule);
    documentTarget.removeEventListener('visibilitychange', schedule);
  };
}
