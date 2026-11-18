import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'wildnews-availability-'));
after(() => rm(directory, { recursive: true, force: true }));
const mocks = {
  nitro: 'export const definePlugin = f => f; export const defineMiddleware = f => f;',
  '@vercel/functions': 'export const waitUntil = p => globalThis.availabilityFixture.jobs.push(p);',
  '../lib/public-cache-store': 'export const getPublicCacheStore = () => globalThis.availabilityFixture.store;',
  '../lib/invalidate-public-pages': 'export const invalidatePublicPages = async () => { globalThis.availabilityFixture.invalidated++; };',
  '../lib/operational-log': 'export const operationalLog = () => {};',
};
const compiled = await build({ entryPoints: ['server/public-availability.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'availability-fixture', setup(builder) {
  builder.onResolve({ filter: /.*/ }, ({ path }) => mocks[path] ? { path, namespace: 'fixture' } : undefined);
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
} }] });
const modulePath = join(directory, 'availability.mjs');
await writeFile(modulePath, compiled.outputFiles[0].text);
const plugin = (await import(pathToFileURL(modulePath).href)).default;

function fixture({ cacheFails = false } = {}) {
  const values = new Map();
  const f = { jobs: [], invalidated: 0, renders: [], body: '<main>Healthy</main>', status: 200, type: 'text/html', headers: {}, store: {
    get: async (key) => { if (cacheFails) throw Error('Injected cache failure'); return values.get(key); },
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
  } };
  globalThis.availabilityFixture = f;
  let middleware;
  const nitro = { h3: { '~middleware': { push: (fn) => { middleware = fn; } } }, fetch: (request) => middleware({ req: request, url: new URL(request.url) }, async () => {
    f.renders.push(request);
    return new Response(request.method === 'HEAD' ? null : f.body, { status: f.status, headers: { 'content-type': f.type, ...f.headers } });
  }) };
  plugin(nitro);
  f.request = (path = '/topics/wildlife', options = {}) => nitro.fetch(new Request(`https://news.wildteam.org.uk${path}`, options));
  return f;
}

for (const bypass of [
  { name: 'semantic query', path: '/topics/wildlife?page=2' },
  { name: 'auth cookie', headers: { cookie: 'sb-fixture-auth-token=private' } },
  { name: 'preview cookie', headers: { cookie: '__prerender_bypass=private' } },
  { name: 'authorization', headers: { authorization: 'Bearer fixture' } },
  { name: 'cache failure', cacheFails: true },
]) for (const method of ['GET', 'HEAD']) test(`${bypass.name} ${method}: error HTML becomes uncached 503, then recovers`, async () => {
  const f = fixture(bypass);
  f.body = '<main data-public-page-unavailable>Temporary failure</main>';
  f.headers = { 'cache-control': 'public, max-age=300', 'vercel-cache-tag': 'old', age: '20', etag: 'old', 'set-cookie': 'fixture=value' };
  const r = await f.request(bypass.path, { method, headers: bypass.headers });
  assert.equal(r.status, 503);
  for (const h of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control']) assert.equal(r.headers.get(h), 'no-store');
  for (const h of ['age', 'etag', 'vercel-cache-tag', 'x-wildnews-cache']) assert.equal(r.headers.get(h), null);
  assert.equal(r.headers.get('set-cookie'), 'fixture=value');
  assert.equal((await r.text()).includes('Temporary failure'), method === 'GET');
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].method, 'GET');
  for (const [key, value] of Object.entries(bypass.headers ?? {})) assert.equal(f.renders[0].headers.get(key), value);
  f.body = '<main>Healthy</main>'; f.headers = {};
  const recovered = await f.request(bypass.path, { method, headers: bypass.headers });
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), method === 'HEAD' ? '' : '<main>Healthy</main>');
});

test('streamed React error template is a 503; serialized marker props are healthy', async () => {
  const f = fixture();
  f.body = '<template data-dgst="database-failure"></template>';
  assert.equal((await f.request('/topics/wildlife?page=2')).status, 503);
  f.body = '<main>Healthy</main><script>{"data-public-page-unavailable":"$undefined","data-dgst":"text"}</script>';
  assert.equal((await f.request('/topics/wildlife?page=2')).status, 200);
});

test('real 404s, redirects, RSC, API, private routes and non-HTML keep their response', async () => {
  const f = fixture();
  for (const status of [301, 302, 307, 308, 404, 410]) {
    f.status = status; f.body = '<template data-dgst="not-found"></template>';
    assert.equal((await f.request('/topics/missing?page=2')).status, status);
  }
  f.status = 200; f.body = '<main data-public-page-unavailable>Error</main>';
  for (const path of ['/api/client-errors', '/admin', '/admin/stories']) assert.equal((await f.request(path)).status, 200);
  for (const headers of [{ rsc: '1' }, { accept: 'text/x-component' }, { 'next-router-state-tree': '[]' }, { 'next-router-prefetch': '1' }, { 'next-action': 'fixture' }]) {
    assert.equal((await f.request('/topics/wildlife?page=2', { headers })).status, 200);
  }
  f.type = 'application/json';
  assert.equal((await f.request('/topics/wildlife?page=2')).status, 200);
});

test('bodyless successful HTML responses remain valid', async () => {
  const f = fixture();
  f.body = null;
  for (const status of [204, 205, 304]) {
    f.status = status;
    assert.equal((await f.request('/topics/wildlife?page=2')).status, status);
  }
});

test('healthy shared-cache burst still renders once; an admin mutation still invalidates', async () => {
  const f = fixture();
  for (const method of ['GET', 'HEAD', 'GET', 'HEAD']) assert.equal((await f.request('/topics/wildlife', { method })).status, 200);
  assert.equal(f.renders.length, 1);
  await f.request('/api/admin/stories', { method: 'PATCH' });
  assert.equal(f.invalidated, 1);
});
