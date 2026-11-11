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
