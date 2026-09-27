import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { employeeTodayFetchInit } from './session-policy';
import {
  cacheHeadersForPath,
  dashboardLiveFetchInit,
  HTML_APP_CACHE_CONTROL,
  isHashedNextStaticAsset,
  nextHtmlAppCacheHeaders,
  operationalApiFetchInit,
  runPersistedPageshowReload,
  shouldReloadOnPageshow,
} from './page-cache';

describe('Safari HTML app cache headers', () => {
  it('HTML app routes receive no-store/no-cache headers', () => {
    for (const path of ['/', '/login', '/app', '/dashboard', '/terminal/main-gate']) {
      const headers = cacheHeadersForPath(path);
      assert.ok(headers);
      assert.equal(
        headers.find((h) => h.key === 'Cache-Control')?.value,
        HTML_APP_CACHE_CONTROL
      );
      assert.equal(headers.find((h) => h.key === 'Pragma')?.value, 'no-cache');
      assert.equal(headers.find((h) => h.key === 'Expires')?.value, '0');
    }
    const configured = nextHtmlAppCacheHeaders();
    assert.ok(configured.some((row) => row.source === '/login'));
    assert.ok(configured.some((row) => row.source === '/terminal/:path*'));
    assert.equal(
      configured.some((row) => row.source.startsWith('/_next/static')),
      false
    );
  });

  it('hashed Next static assets are not targeted by those custom headers', () => {
    assert.equal(isHashedNextStaticAsset('/_next/static/chunks/app.js'), true);
    assert.equal(cacheHeadersForPath('/_next/static/chunks/app.js'), null);
    assert.equal(cacheHeadersForPath('/_next/static/css/app.css'), null);
  });
});

describe('Safari BFCache pageshow', () => {
  it('pageshow persisted triggers reload helper', () => {
    let reloads = 0;
    assert.equal(shouldReloadOnPageshow({ persisted: true }), true);
    assert.equal(
      runPersistedPageshowReload({ persisted: true }, () => {
        reloads += 1;
      }),
      true
    );
    assert.equal(reloads, 1);
  });

  it('normal pageshow does not reload', () => {
    let reloads = 0;
    assert.equal(shouldReloadOnPageshow({ persisted: false }), false);
    assert.equal(
      runPersistedPageshowReload({ persisted: false }, () => {
        reloads += 1;
      }),
      false
    );
    assert.equal(reloads, 0);
  });
});

describe('operational fetches', () => {
  it('operational fetches use no-store', () => {
    assert.deepEqual(employeeTodayFetchInit(), { credentials: 'include', cache: 'no-store' });
    assert.deepEqual(dashboardLiveFetchInit(), { credentials: 'include', cache: 'no-store' });
    assert.deepEqual(operationalApiFetchInit(), { credentials: 'include', cache: 'no-store' });
  });
});
