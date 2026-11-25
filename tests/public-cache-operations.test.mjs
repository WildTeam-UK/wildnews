import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'wildnews-cache-operations-'));
after(() => rm(directory, { recursive: true, force: true }));
const mocks = {
  '@vercel/functions': 'export const getCache = () => globalThis.cacheOperationsFixture.store; export const dangerouslyDeleteByTag = async () => { const f=globalThis.cacheOperationsFixture; f.cdnPurges++; if(f.cdnFails) throw Error("CDN fixture failure"); };',
  '@/lib/supabase/admin': 'export const getSupabaseAdminClient = () => globalThis.cacheOperationsFixture.admin;',
  '@/lib/published-stories': 'export const getPublishedStories = async () => [{ id: "public-fixture" }];',
};
const compiled = await build({ stdin: { contents: 'export { GET } from "./app/api/health/route.ts"; export { invalidatePublicPages, onPublicPageInvalidation } from "./lib/invalidate-public-pages.ts";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'cache-operations-fixture', setup(builder) {
  builder.onResolve({ filter: /.*/ }, ({ path }) => mocks[path] ? { path, namespace: 'fixture' } : undefined);
  builder.onResolve({ filter: /(?:^@\/lib\/|^\.\/)operational-log$/ }, () => ({ path: 'log', namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path] ?? 'export const operationalLog = (_level, fields) => globalThis.cacheOperationsFixture.reports.push(fields.operation);', loader: 'js' }));
} }] });
const modulePath = join(directory, 'operations.mjs');
await writeFile(modulePath, compiled.outputFiles[0].text);
let sequence = 0;

async function fixture(t, mode = 'healthy') {
  const values = new Map();
  const tags = new Map();
  const f = { mode, values, reports: [], cdnPurges: 0, cdnFails: false, probeWrites: 0, store: {
    get: async (key) => {
      if (f.mode === 'throw') throw Error('Cache fixture outage');
      if (f.mode === 'hang') return new Promise(() => {});
      return f.mode === 'healthy' ? values.get(key) : null;
    },
    set: async (key, value, options) => {
      if (key.includes(':health:')) f.probeWrites++;
      if (f.mode === 'healthy') { values.set(key, value); tags.set(key, options?.tags ?? []); }
    },
    delete: async (key) => { values.delete(key); tags.delete(key); },
    expireTag: async (tag) => { if (f.mode === 'healthy') for (const [key, entryTags] of tags) if (entryTags.includes(tag)) { values.delete(key); tags.delete(key); } },
  } };
  f.admin = { from(table) {
    const result = { data: table === 'digest_deliveries' ? [] : { automation_enabled: false, auto_publish_enabled: false, social_distribution_enabled: false, email_distribution_enabled: false, consecutive_automation_failures: 0 }, error: null };
    const q = { select: () => q, eq: () => q, in: () => q, single: async () => result, limit: async () => result }; return q;
  } };
  globalThis.cacheOperationsFixture = f;
  t.mock.method(Date, 'now', () => f.time ?? 1000);
  const oldVercel = process.env.VERCEL;
  const oldDeployment = process.env.VERCEL_DEPLOYMENT_ID;
  process.env.VERCEL = '1'; process.env.VERCEL_DEPLOYMENT_ID = 'operations-fixture';
  t.after(() => {
    if (oldVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = oldVercel;
    if (oldDeployment === undefined) delete process.env.VERCEL_DEPLOYMENT_ID; else process.env.VERCEL_DEPLOYMENT_ID = oldDeployment;
  });
  f.module = await import(`${pathToFileURL(modulePath).href}?case=${sequence++}`);
  return f;
}

test('health detects silently discarded cache writes and reports recovery after the bounded probe interval', async (t) => {
  const f = await fixture(t, 'silent');
  const failed = await f.module.GET();
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.equal(body.checks.public_cache, 'unavailable');
  assert.equal(body.checks.public_pages, 'healthy');
  assert.equal(body.ok, false);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.match(failed.headers.get('x-robots-tag'), /noindex/);
  f.mode = 'healthy'; f.time = 32_000;
  const recovered = await f.module.GET();
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).checks.public_cache, 'healthy');
  assert.equal([...f.values.keys()].some((key) => key.includes(':health:')), false);
});

test('concurrent health calls share one cache storage probe', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.module.GET()));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(f.probeWrites, 1);
});

test('a throwing cache reports unknown page markers without mislabelling the database as unavailable', async (t) => {
  const f = await fixture(t, 'throw');
  const response = await f.module.GET();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.checks.database, 'healthy');
  assert.equal(body.checks.public_cache, 'unavailable');
  assert.equal(body.checks.public_pages, 'unknown');
});

test('a hung cache cannot indefinitely hang the health endpoint', async (t) => {
  const f = await fixture(t, 'hang');
  const started = performance.now();
  const response = await f.module.GET();
  assert.equal(response.status, 503);
  assert.ok(performance.now() - started < 1500);
});

test('editorial invalidation retires local snapshots and rotates the shared generation', async (t) => {
  const f = await fixture(t);
  f.values.set('operations-fixture:epoch', 'previous');
  let invalidations = 0;
  t.after(f.module.onPublicPageInvalidation(() => { invalidations++; }));
  await f.module.invalidatePublicPages();
  assert.equal(invalidations, 1);
  assert.notEqual(f.values.get('operations-fixture:epoch'), 'previous');
  assert.equal(typeof f.values.get('operations-fixture:epoch'), 'string');
  assert.equal(f.cdnPurges, 1);
  assert.equal(f.reports.includes('public_cache_invalidation_failed'), false);
});

test('silent cache failure cannot skip the CDN purge or retry an already committed editorial change', async (t) => {
  const f = await fixture(t, 'silent');
  let invalidations = 0;
  t.after(f.module.onPublicPageInvalidation(() => { invalidations++; }));
  await f.module.invalidatePublicPages();
  assert.equal(invalidations, 1);
  assert.equal(f.cdnPurges, 1);
  assert.ok(f.reports.includes('public_cache_invalidation_failed'));
});

test('failed CDN invalidation is marked unhealthy and a later successful invalidation clears it', async (t) => {
  const f = await fixture(t);
  f.cdnFails = true;
  await f.module.invalidatePublicPages();
  assert.equal(f.values.get('invalidation-failure'), true);
  assert.equal((await f.module.GET()).status, 503);
  f.cdnFails = false;
  await f.module.invalidatePublicPages();
  assert.equal(f.values.has('invalidation-failure'), false);
  assert.equal((await f.module.GET()).status, 200);
});

test('concurrent editorial invalidations accept the newest generation without false failure markers', async (t) => {
  const f = await fixture(t);
  f.values.set('operations-fixture:epoch', 'previous');
  await Promise.all([f.module.invalidatePublicPages(), f.module.invalidatePublicPages()]);
  assert.equal(f.cdnPurges, 2);
  assert.equal(f.values.has('invalidation-failure'), false);
  assert.equal(f.reports.includes('public_cache_invalidation_failed'), false);
});

test('an invalidation from a separately bundled module reaches the middleware listener', async (t) => {
  const f = await fixture(t);
  let invalidations = 0;
  t.after(f.module.onPublicPageInvalidation(() => { invalidations++; }));
  const otherBundle = await import(`${pathToFileURL(modulePath).href}?case=${sequence++}`);
  await otherBundle.invalidatePublicPages();
  assert.equal(invalidations, 1);
});

test('a synchronously throwing diagnostic write cannot make a committed mutation reject', async (t) => {
  const f = await fixture(t);
  f.store.set = () => { throw Error('Synchronous fixture cache failure'); };
  await f.module.invalidatePublicPages();
  assert.equal(f.cdnPurges, 1);
  assert.ok(f.reports.includes('public_cache_invalidation_failed'));
});
