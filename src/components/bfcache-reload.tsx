'use client';

import { useEffect } from 'react';
import { runPersistedPageshowReload } from '@/lib/page-cache';

export default function BfCacheReload() {
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      runPersistedPageshowReload(event, () => {
        window.location.reload();
      });
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  return null;
}
