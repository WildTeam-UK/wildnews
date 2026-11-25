import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's type-stripping test runner requires the source extension.
import { createPublicPageCache, publicPagePath, PUBLIC_PAGE_TAG } from '../lib/public-page-cache.ts';

const request = (path = '/', method = 'GET', headers?: HeadersInit) => new Request(`https://news.wildteam.org.uk${path}`, { method, headers });
const html = (body = '<main>Published stories</main>', status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

function fixture() {
  let time = 1000;
  let renders = 0;
  let render: () => Promise<Response> = async () => html();
  const entries = new Map<string, { value: unknown; tags: string[] }>();
  const background: Promise<unknown>[] = [];
  const reports: string[] = [];
  const cache = createPublicPageCache({
    deployment: 'test-deployment',
    store: {
      get: async (key) => entries.get(key)?.value,
      set: async (key, value, options) => { entries.set(key, { value, tags: options.tags }); },
      delete: async (key) => { entries.delete(key); },
    },
    render: async () => { renders++; return render(); },
    background: (work) => { background.push(work); },
    report: (operation) => { reports.push(operation); },
    now: () => time,
  });
  return {
    cache, background, reports, entries,
    renders: () => renders,
    advance: (milliseconds: number) => { time += milliseconds; },
    renderWith: (callback: () => Promise<Response>) => { render = callback; },
    purge: () => { cache.invalidate(); for (const [key, entry] of entries) if (entry.tags.includes(PUBLIC_PAGE_TAG)) entries.delete(key); },
  };
}

void test('a simultaneous GET and HEAD burst share one anonymous render', async () => {
  const f = fixture();
  let release!: () => void;
  f.renderWith(async () => { await new Promise<void>((resolve) => { release = resolve; }); return html(); });
  const responses = Promise.all(Array.from({ length: 30 }, (_, i) => f.cache.serve(request('/', i % 2 ? 'HEAD' : 'GET'))));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.renders(), 1);
  release();
  const results = await responses;
  for (const [index, response] of results.entries()) {
    assert.equal(response?.status, 200);
    assert.equal(await response?.text(), index % 2 ? '' : '<main>Published stories</main>');
  }
  assert.equal((await f.cache.serve(request()))?.headers.get('X-WildNews-Cache'), 'HIT');
  assert.equal(f.renders(), 1);
});

void test('last successful content survives refresh failure but expires after ten minutes', async () => {
  const f = fixture();
  await f.cache.serve(request());
  f.advance(301_000);
  f.renderWith(async () => html('<main data-public-page-unavailable>Unavailable</main>'));
  const stale = await f.cache.serve(request());
  assert.equal(stale?.headers.get('X-WildNews-Cache'), 'STALE');
  assert.match(await stale!.text(), /Published stories/);
  await Promise.all(f.background);
  assert.ok(f.reports.includes('public_page_render_failed'));
  assert.ok(f.entries.has('render-failure'));
  f.advance(300_000);
  assert.equal((await f.cache.serve(request()))?.status, 503);
});

void test('five minutes of public visits reuse one render and CDN freshness never extends it', async () => {
  const f = fixture();
  await f.cache.serve(request());
  for (let minute = 1; minute < 5; minute++) {
    f.advance(60_000);
    const response = await f.cache.serve(request());
    assert.equal(response?.headers.get('X-WildNews-Cache'), 'HIT');
    assert.equal(response?.headers.get('Vercel-CDN-Cache-Control'), `public, max-age=${300 - minute * 60}`);
  }
  assert.equal(f.renders(), 1);
  f.advance(60_000);
  assert.equal((await f.cache.serve(request()))?.headers.get('X-WildNews-Cache'), 'STALE');
  await Promise.all(f.background);
  assert.equal(f.renders(), 2);
});

void test('an error boundary returned with HTTP 200 is converted to 503 and never cached', async () => {
  const f = fixture();
  f.renderWith(async () => html('<main data-public-page-unavailable>Unavailable</main>'));
  assert.equal((await f.cache.serve(request()))?.status, 503);
  f.renderWith(async () => html());
  assert.equal((await f.cache.serve(request()))?.status, 200);
  assert.equal(f.entries.has('render-failure'), false);
  assert.equal(f.renders(), 2);
});

void test('optional-section failures and cookie-setting responses are not stored', async () => {
  const f = fixture();
  f.renderWith(async () => html('<main data-public-page-degraded>Story remains readable</main>'));
  assert.equal((await f.cache.serve(request()))?.status, 200);
  assert.equal((await f.cache.serve(request()))?.headers.get('X-WildNews-Cache'), 'BYPASS');
  assert.equal(f.renders(), 2);
  f.renderWith(async () => { const response = html(); response.headers.set('Set-Cookie', 'private=value'); return response; });
  await f.cache.serve(request());
  await f.cache.serve(request());
  assert.equal(f.renders(), 4);
});

void test('serialized React props do not turn a healthy page into a cache bypass', async () => {
  const f = fixture();
  f.renderWith(async () => html('<main>Healthy</main><script>{"data-public-page-degraded":"$undefined"}</script>'));
  await f.cache.serve(request());
  assert.equal((await f.cache.serve(request()))?.headers.get('X-WildNews-Cache'), 'HIT');
  assert.equal(f.renders(), 1);
});

void test('archiving invalidates snapshots and prevents an older in-flight render repopulating them', async () => {
  const f = fixture();
  let release!: () => void;
  f.renderWith(async () => { await new Promise<void>((resolve) => { release = resolve; }); return html('Old published story'); });
  const pending = f.cache.serve(request('/stories/example'));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.purge();
  release();
  await pending;
  f.renderWith(async () => html('Not found', 404));
  assert.equal((await f.cache.serve(request('/stories/example')))?.status, 404);
  assert.equal(f.renders(), 2);
});

void test('private, preview, RSC, API and non-public requests bypass caching', () => {
  for (const req of [request('/admin'), request('/api/health'), request('/', 'POST'), request('/', 'GET', { authorization: 'Bearer private' }), request('/', 'GET', { cookie: 'sb-project-auth-token=private' }), request('/', 'GET', { cookie: '__prerender_bypass=private' }), request('/', 'GET', { rsc: '1' }), request('/?search=private')]) assert.equal(publicPagePath(req), null);
  assert.equal(publicPagePath(request('/?utm_source=newsletter&_gl=tracking')), '/');
});

function outageFixture() {
  let time = 1000;
  let healthy = false;
  let throws = false;
  let renders = 0;
  let reads = 0;
  let body = '<main>Published stories</main>';
  let status = 200;
  const entries = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const reports: string[] = [];
  const cache = createPublicPageCache({
    deployment: 'outage-test',
    store: {
      get: async (key) => {
        reads++;
        if (!healthy && throws) throw Error('Cache unavailable');
        return healthy ? entries.get(key) : null;
      },
      // This matches the installed SDK's failed-write behaviour: resolve, no value retained.
      set: async (key, value) => { if (healthy) entries.set(key, value); },
      delete: async (key) => { entries.delete(key); },
    },
    render: async () => { renders++; return html(body, status); },
    background: (work) => { background.push(work); },
    report: (operation) => { reports.push(operation); },
    now: () => time,
  });
  return {
    cache, entries, background, reports,
    renders: () => renders, reads: () => reads,
    advance: (ms: number) => { time += ms; },
    recover: () => { healthy = true; },
    fail: (hard = false) => { healthy = false; throws = hard; },
    renderWith: (value: string, code = 200) => { body = value; status = code; },
  };
}

void test('silent cache failure retains healthy HTML locally and backs off cache probes', async () => {
  const f = outageFixture();
  const first = await f.cache.serve(request());
  assert.equal(first?.status, 200);
  assert.equal(first?.headers.get('X-WildNews-Cache'), 'LOCAL-MISS');
  assert.equal(first?.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  const reads = f.reads();
  for (let n = 0; n < 20; n++) {
    const response = await f.cache.serve(request());
    assert.equal(response?.headers.get('X-WildNews-Cache'), 'LOCAL-HIT');
    assert.match(await response!.text(), /Published stories/);
  }
  assert.equal(f.renders(), 1);
  assert.equal(f.reads(), reads);
  assert.ok(f.reports.includes('public_page_cache_unavailable'));
});

void test('cache recovery returns to verified shared caching without reusing an unverified generation', async () => {
  const f = outageFixture();
  await f.cache.serve(request());
  f.recover(); f.advance(31_000);
  f.renderWith('<main>Newly published stories</main>');
  const response = await f.cache.serve(request());
  assert.equal(response?.headers.get('X-WildNews-Cache'), 'MISS');
  assert.match(await response!.text(), /Newly published/);
  assert.equal((await f.cache.serve(request()))?.headers.get('X-WildNews-Cache'), 'HIT');
  assert.ok(f.reports.includes('public_page_cache_recovered'));
});

void test('a shared epoch change retires a warm instance snapshot', async () => {
  const f = outageFixture(); f.recover();
  await f.cache.serve(request('/stories/example'));
  f.entries.set('outage-test:epoch', 'changed-by-another-worker');
  f.renderWith('<main>Not found</main>', 404);
  assert.equal((await f.cache.serve(request('/stories/example')))?.status, 404);
  assert.equal(f.renders(), 2);
});

void test('a hard cache outage reuses warm content, while a local withdrawal retires it immediately', async () => {
  const f = outageFixture(); f.recover();
  await f.cache.serve(request('/stories/example'));
  f.fail(true);
  assert.equal((await f.cache.serve(request('/stories/example')))?.headers.get('X-WildNews-Cache'), 'LOCAL-HIT');
  assert.equal(f.renders(), 1);
  f.cache.invalidate();
  f.renderWith('<main>Not found</main>', 404);
  assert.equal((await f.cache.serve(request('/stories/example')))?.status, 404);
});

void test('fallback freshness is 30 seconds and failure never extends the ten-minute content limit', async () => {
  const f = outageFixture();
  await f.cache.serve(request());
  f.advance(31_000);
  f.renderWith('<main data-public-page-unavailable>Unavailable</main>');
  assert.equal((await f.cache.serve(request()))?.headers.get('X-WildNews-Cache'), 'LOCAL-STALE');
  await Promise.all(f.background);
  f.advance(570_000);
  assert.equal((await f.cache.serve(request()))?.status, 503);
});

void test('an origin exception produces one uncached 503 without asking middleware to render again', async () => {
  const f = fixture();
  f.renderWith(async () => { throw Error('Injected origin failure'); });
  const response = await f.cache.serve(request());
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  assert.equal(f.renders(), 1);
});

void test('a hung cache is bounded and a 30-request cold fallback burst renders only once', async () => {
  let renders = 0;
  const cache = createPublicPageCache({
    deployment: 'hung-cache',
    store: { get: () => new Promise(() => {}), set: async () => {}, delete: async () => {} },
    render: async () => { renders++; return html(); },
    background: () => {}, report: () => {},
  });
  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => cache.serve(request('/', i % 2 ? 'HEAD' : 'GET'))));
  assert.ok(Date.now() - started < 1500);
  assert.equal(renders, 1);
  for (const [index, response] of responses.entries()) {
    assert.equal(response?.status, 200);
    assert.equal(await response!.text(), index % 2 ? '' : '<main>Published stories</main>');
  }
});

void test('silent HTML-write failure is detected even when the epoch is retained', async () => {
  const values = new Map<string, unknown>();
  const reports: string[] = [];
  let renders = 0;
  const cache = createPublicPageCache({
    deployment: 'write-failure',
    store: {
      get: async (key) => values.get(key),
      set: async (key, value) => { if (key.endsWith(':epoch')) values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    },
    render: async () => { renders++; return html(); }, background: () => {},
    report: (operation) => { reports.push(operation); },
  });
  assert.equal((await cache.serve(request()))?.headers.get('X-WildNews-Cache'), 'LOCAL-MISS');
  assert.equal((await cache.serve(request()))?.headers.get('X-WildNews-Cache'), 'LOCAL-HIT');
  assert.equal(renders, 1);
  assert.ok(reports.includes('public_page_cache_unavailable'));
});

void test('a withdrawal during a fallback render does not share or retain the older work', async () => {
  let release!: () => void;
  let first = true;
  const cache = createPublicPageCache({
    deployment: 'local-withdrawal',
    store: { get: async () => null, set: async () => {}, delete: async () => {} },
    render: async () => {
      if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; }); return html('Old content'); }
      return html('Not found', 404);
    },
    background: () => {}, report: () => {},
  });
  const older = cache.serve(request('/stories/example'));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  cache.invalidate();
  assert.equal((await cache.serve(request('/stories/example')))?.status, 404);
  release(); await older;
  assert.equal((await cache.serve(request('/stories/example')))?.status, 404);
});

void test('local fallback evicts least-recently-used entries rather than growing with every URL', async () => {
  const f = outageFixture();
  for (let i = 0; i < 65; i++) await f.cache.serve(request(`/stories/example-${i}`));
  assert.equal(f.renders(), 65);
  await f.cache.serve(request('/stories/example-64'));
  assert.equal(f.renders(), 65);
  await f.cache.serve(request('/stories/example-0'));
  assert.equal(f.renders(), 66);
});

void test('a successful 404 refresh retires a fallback article before the ten-minute safety limit', async () => {
  const f = outageFixture();
  await f.cache.serve(request('/stories/example'));
  f.advance(31_000); f.renderWith('Not found', 404);
  assert.equal((await f.cache.serve(request('/stories/example')))?.headers.get('X-WildNews-Cache'), 'LOCAL-STALE');
  await Promise.all(f.background);
  assert.equal((await f.cache.serve(request('/stories/example')))?.status, 404);
});

void test('an invalidation during a delayed shared read cannot repopulate local or CDN content', async () => {
  let release!: () => void;
  let version = 'before';
  let delayed = true;
  const cache = createPublicPageCache({
    deployment: 'read-withdrawal',
    store: {
      get: async (key) => {
        if (key.endsWith(':epoch')) return version;
        if (delayed) {
          delayed = false;
          await new Promise<void>((resolve) => { release = resolve; });
          return { body: '<main>Old published article</main>', headers: [['content-type', 'text/html']], createdAt: Date.now() };
        }
        return null;
      },
      set: async () => {}, delete: async () => {},
    },
    render: async () => html('Not found', 404), background: () => {}, report: () => {},
  });
  const pendingRead = cache.serve(request('/stories/example'));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  version = 'after'; cache.invalidate(); release();
  const response = await pendingRead;
  assert.equal(response?.status, 404);
  assert.equal(response?.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  assert.equal((await cache.serve(request('/stories/example')))?.status, 404);
});

void test('a synchronously throwing failure-marker write cannot turn one failed origin render into a retry', async () => {
  const values = new Map<string, unknown>();
  let renders = 0;
  const cache = createPublicPageCache({
    deployment: 'marker-throw',
    store: {
      get: async (key) => values.get(key),
      set: (key, value) => { if (key === 'render-failure') throw Error('Synchronous fixture failure'); values.set(key, value); return Promise.resolve(); },
      delete: async () => {},
    },
    render: async () => { renders++; return html('<main data-public-page-unavailable>Unavailable</main>'); },
    background: () => {}, report: () => {},
  });
  assert.equal((await cache.serve(request()))?.status, 503);
  assert.equal(renders, 1);
});
