import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Use the installed Supabase SDK, not a mock query builder, to catch retries
// introduced underneath the application's custom fetch boundary.
const directory = await mkdtemp(join(tmpdir(), 'wildnews-public-db-'));
after(() => rm(directory, { recursive: true, force: true }));
const compiled = await build({ stdin: { contents: 'export { getSupabasePublicClient } from "./lib/supabase/public.ts"; export { withPublicReadBudget } from "./lib/public-read-budget.ts";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'public-db-fixture', setup(builder) {
  builder.onResolve({ filter: /^\.\/config$/ }, () => ({ path: 'config', namespace: 'fixture' }));
  builder.onResolve({ filter: /^@\/lib\/operational-log$/ }, () => ({ path: 'log', namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'config'
    ? 'export const getPublicSupabaseConfig = () => ({ url: "https://public-db-fixture.invalid", publishableKey: "local-fixture-key" });'
    : 'export const operationalLog = () => {};', loader: 'js' }));
} }] });
// Resolve the real SDK from the project's dependency tree.
const modulePath = join(directory, 'public.mjs');
await writeFile(modulePath, compiled.outputFiles[0].text.replaceAll("'@supabase/supabase-js'", JSON.stringify(import.meta.resolve('@supabase/supabase-js'))).replaceAll('"@supabase/supabase-js"', JSON.stringify(import.meta.resolve('@supabase/supabase-js'))));
const { getSupabasePublicClient, withPublicReadBudget } = await import(pathToFileURL(modulePath).href);
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

test('public database reads do not retry transient HTTP failures', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"message":"Temporary fixture outage"}', { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
  };
  const { error, status } = await getSupabasePublicClient().from('stories').select('id');
  assert.equal(calls, 1);
  assert.equal(status, 503);
  assert.ok(error);
});

test('a public database timeout expires once at six seconds instead of resetting through SDK retries', async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  // Keep the test process alive: AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setInterval(() => {}, 1000);
  const started = Date.now();
  try {
    const { error } = await getSupabasePublicClient().from('stories').select('id');
    assert.ok(error);
    assert.equal(calls, 1);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 5800 && elapsed < 7500, `Unexpected timeout duration: ${elapsed}ms`);
  } finally { clearInterval(keepAlive); }
});

test('a subsequent public read recovers and caller cancellation is preserved', async () => {
  globalThis.fetch = async () => new Response('[{"id":"public-fixture"}]', { headers: { 'content-type': 'application/json' } });
  const result = await getSupabasePublicClient().from('stories').select('id');
  assert.equal(result.error, null);
  assert.deepEqual(result.data, [{ id: 'public-fixture' }]);
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = async (_input, init) => { calls++; assert.equal(init.signal.aborted, true); throw init.signal.reason; };
  assert.ok((await getSupabasePublicClient().from('stories').select('id').abortSignal(controller.signal)).error);
  assert.equal(calls, 1);
});

test('later page reads share the original deadline and the next request receives a fresh budget', async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    if (calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    }
    return new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  const keepAlive = setInterval(() => {}, 1000);
  const started = performance.now();
  try {
    await withPublicReadBudget(async () => {
      assert.equal((await getSupabasePublicClient().from('stories').select('id')).error, null);
      assert.ok((await getSupabasePublicClient().from('topics').select('name')).error);
    });
    assert.ok(performance.now() - started < 7500);
    assert.equal(calls, 2);
    globalThis.fetch = async (_input, init) => {
      assert.equal(init.signal.aborted, false);
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };
    await withPublicReadBudget(async () => assert.equal((await getSupabasePublicClient().from('stories').select('id')).error, null));
  } finally { clearInterval(keepAlive); }
});
