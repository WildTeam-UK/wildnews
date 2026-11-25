import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Entirely offline: real production build + real installed cache/database SDKs,
// with loopback HTTP fixtures for both providers. No real keys or external writes.
const directory = await mkdtemp(join(tmpdir(), 'wildnews-cache-outage-'));
const clockPath = join(directory, 'clock.txt');
const clockImport = join(directory, 'clock.mjs');
await writeFile(clockPath, '0');
await writeFile(clockImport, `import {readFileSync} from 'node:fs'; const realNow=Date.now; Date.now=()=>realNow()+Number(readFileSync(${JSON.stringify(clockPath)},'utf8'));`);
let clockOffset = 0;
async function advance(ms) { clockOffset += ms; await writeFile(clockPath, String(clockOffset)); }
let cacheMode = '429';
let databaseMode = 'healthy';
let reads = 0;
let cacheRequests = 0;
let fixtureWrites = 0;
let withdrawn = false;
const results = [];
const cached = new Map();
const fixtureId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const stories = Array.from({ length: 25 }, (_, i) => ({
  id: i ? `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` : fixtureId,
  slug: `cache-fixture-${i + 1}`, headline: `Fixture conservation story ${i + 1}`,
  standfirst: 'A source-linked conservation briefing used only in a local verification fixture.',
  status: 'published', content_type: 'news', published_at: '2026-11-20T08:00:00Z',
  updated_at: '2026-11-20T08:00:00Z', image_url: '/og.png', image_alt: 'Local fixture',
  story_topics: [{ topics: { name: 'Wildlife', slug: 'wildlife' } }], story_tags: [],
  story_conservation_outlooks: [], article_topics: ['Wildlife'], digest_topics: [],
  article_image: '/og.png', generation_metadata: { article_content: { topics: ['Wildlife'], image_url: '/og.png' } },
}));
const json = (res, body, status = 200, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const database = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (url.pathname === '/auth/v1/user') return json(res, { id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', created_at: '2026-01-01T00:00:00Z' });
  if (url.pathname === '/rest/v1/admin_users') return json(res, { user_id: userId });
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (req.method === 'PATCH' && url.pathname === '/rest/v1/stories' && url.searchParams.get('id') === `eq.${fixtureId}`) { withdrawn = true; fixtureWrites++; res.writeHead(204).end(); return; }
    if (['/rest/v1/editorial_actions', '/rest/v1/publication_queue'].includes(url.pathname)) { fixtureWrites++; res.writeHead(204).end(); return; }
    res.writeHead(405).end(); return;
  }
  reads++;
  if (databaseMode === 'hang') return;
  if (databaseMode === 'slow') await new Promise((resolve) => setTimeout(resolve, 5500));
  if (databaseMode === '503') return json(res, { message: 'Local fixture outage', code: 'FIXTURE_OUTAGE' }, 503, { 'retry-after': '0' });
  if (url.pathname === '/rest/v1/stories') {
    let rows = stories.filter((row) => !withdrawn || row.id !== fixtureId);
    if (url.searchParams.has('slug')) rows = rows.filter((row) => `eq.${row.slug}` === url.searchParams.get('slug'));
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-range': `0-0/${rows.length}` }).end(); return; }
    return json(res, rows.slice(0, Number(url.searchParams.get('limit') ?? 1000)));
  }
  if (url.pathname === '/rest/v1/topics') return json(res, [{ name: 'Wildlife', slug: 'wildlife', active: true, description: 'Fixture wildlife archive' }]);
  if (url.pathname === '/rest/v1/good_news_settings') return json(res, { minimum_score: 70, minimum_confidence: 70 });
  if (['/rest/v1/editorial_run_settings', '/rest/v1/digest_settings'].includes(url.pathname)) return json(res, { automation_enabled: false, auto_publish_enabled: false, social_distribution_enabled: false, email_distribution_enabled: false, consecutive_automation_failures: 0 });
  return json(res, []);
});
const cache = createServer(async (req, res) => {
  cacheRequests++;
  if (cacheMode === '429') { res.writeHead(429).end('Local fixture cache rate limit'); return; }
  const key = req.url;
  if (key.startsWith('/cache/revalidate')) { cached.clear(); res.writeHead(200).end(); return; }
  if (req.method === 'GET') {
    if (!cached.has(key)) { res.writeHead(404).end(); return; }
    return json(res, cached.get(key), 200, { 'x-vercel-cache-state': 'fresh' });
  }
  if (req.method === 'DELETE') { cached.delete(key); res.writeHead(200).end(); return; }
  const parts = []; for await (const part of req) parts.push(part);
  cached.set(key, JSON.parse(Buffer.concat(parts).toString())); res.writeHead(200).end();
});
await new Promise((resolve, reject) => { database.once('error', reject); database.listen(0, '127.0.0.1', resolve); });
await new Promise((resolve, reject) => { cache.once('error', reject); cache.listen(0, '127.0.0.1', resolve); });
const databaseUrl = `http://127.0.0.1:${database.address().port}`;
const cacheUrl = `http://127.0.0.1:${cache.address().port}/cache/`;
const port = '3198';
const base = `http://127.0.0.1:${port}`;
let entry = '.output/server/index.mjs';
if (process.argv.includes('--vercel')) {
  entry = join(directory, 'vercel.mjs');
  const handlerUrl = pathToFileURL(resolve('.vercel/output/functions/__server.func/index.mjs')).href;
  await writeFile(entry, `import {createServer} from 'node:http';
const app=(await import(${JSON.stringify(handlerUrl)})).default;
createServer(async(req,res)=>{try{
  const parts=[];for await(const part of req)parts.push(part);
  const work=[];const response=await app.fetch(new Request(${JSON.stringify(base)}+req.url,{method:req.method,headers:req.headers,body:parts.length?Buffer.concat(parts):undefined}),{waitUntil:p=>work.push(p)});
  const body=await response.arrayBuffer();res.writeHead(response.status,Object.fromEntries(response.headers)).end(req.method==='HEAD'?undefined:Buffer.from(body));
  await Promise.allSettled(work);
}catch(error){console.error(error);res.writeHead(500).end('Local Vercel fixture failed');}}).listen(Number(process.env.PORT),'127.0.0.1');`);
}
const app = spawn(process.execPath, ['--import', clockImport, entry], {
  cwd: process.cwd(),
  // Deliberately do not inherit provider credentials or production configuration.
  env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: port, HOST: '127.0.0.1',
    NEXT_PUBLIC_SUPABASE_URL: databaseUrl, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'local-public-fixture-key',
    SUPABASE_URL: databaseUrl, SUPABASE_SECRET_KEY: 'local-admin-fixture-key',
    RUNTIME_CACHE_ENDPOINT: cacheUrl, RUNTIME_CACHE_HEADERS: '{}',
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [app.stdout, app.stderr]) stream.on('data', (chunk) => { logs += chunk; });
async function get(path = '/', options = {}) {
  const start = performance.now();
  const response = await fetch(base + path, { ...options, headers: { 'user-agent': 'Google-InspectionTool/1.0', ...options.headers } });
  const body = await response.text();
  return { response, body, durationMs: Math.round(performance.now() - start) };
}
function healthyPage(result) {
  assert.equal(result.response.status, 200, result.body.slice(0, 200));
  const head = result.body.split('</head>')[0];
  assert.equal((head.match(/rel="canonical"/g) ?? []).length, 1);
  assert.match(head, /href="https:\/\/news\.wildteam\.org\.uk\/?"/);
  assert.match(head, /name="robots" content="index, follow"/);
  assert.match(result.body, /Latest stories/);
  assert.doesNotMatch(result.body, /<main[^>]*data-public-page-(?:unavailable|degraded)/);
}
try {
  let started = false;
  for (let i = 0; i < 100; i++) {
    try { await get('/manifest.webmanifest'); started = true; break; }
    catch { if (app.exitCode !== null) throw Error(`Local build exited: ${logs.slice(-2000)}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(started, 'Local server did not start');
  const first = await get(); healthyPage(first);
  assert.equal(first.response.headers.get('x-wildnews-cache'), 'LOCAL-MISS');
  assert.equal(first.response.headers.get('vercel-cdn-cache-control'), 'no-store');
  const initialReads = reads;
  const initialCacheRequests = cacheRequests;
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => get('/', { method: i % 2 ? 'HEAD' : 'GET' })));
  for (const [i, result] of burst.entries()) {
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('x-wildnews-cache'), 'LOCAL-HIT');
    if (i % 2) assert.equal(result.body, ''); else healthyPage(result);
  }
  assert.equal(reads, initialReads); assert.equal(cacheRequests, initialCacheRequests);
  results.push({ check: 'real_SDK_cache_429_then_30_GET_HEAD_visits', originReads: reads - initialReads, additionalCacheRequests: cacheRequests - initialCacheRequests, status: 200 });
  const health = await get('/api/health');
  assert.equal(health.response.status, 503); assert.equal(JSON.parse(health.body).checks.public_cache, 'unavailable');
  results.push({ check: 'health_detects_real_SDK_429', status: health.response.status });

  databaseMode = 'hang'; await advance(601_000);
  const beforeTimeout = reads;
  const timeout = await get();
  assert.equal(timeout.response.status, 503);
  assert.equal(timeout.response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.ok(timeout.durationMs >= 5800 && timeout.durationMs < 8000, `Timeout exceeded one deadline: ${timeout.durationMs}ms`);
  assert.ok(reads - beforeTimeout <= 11, `Unexpected database retry wave: ${reads - beforeTimeout}`);
  results.push({ check: 'expired_snapshot_and_hung_database', status: 503, durationMs: timeout.durationMs, databaseAttempts: reads - beforeTimeout });
  databaseMode = 'healthy';
  const restored = await get(); healthyPage(restored);
  results.push({ check: 'origin_recovers_without_cached_error', status: restored.response.status, cache: restored.response.headers.get('x-wildnews-cache') });

  cacheMode = 'healthy'; await advance(31_000);
  const shared = await get(); healthyPage(shared);
  assert.equal(shared.response.headers.get('x-wildnews-cache'), 'MISS');
  assert.equal((await get()).response.headers.get('x-wildnews-cache'), 'HIT');
  const recoveredHealth = await get('/api/health');
  assert.equal(recoveredHealth.response.status, 200);
  results.push({ check: 'cache_and_health_recover', status: 200, publicCache: JSON.parse(recoveredHealth.body).checks.public_cache });

  // Only the fixture server accepts these writes. The real admin route must
  // invalidate both its local snapshot and the remote SDK cache after withdrawal.
  const jwt = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'local-signature'].join('.');
  const session = { access_token: jwt, refresh_token: 'local-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: userId } };
  const cookie = `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const unpublish = await get(`/api/admin/drafts/${fixtureId}/publish`, { method: 'DELETE', headers: { cookie } });
  assert.equal(unpublish.response.status, 200, unpublish.body);
  assert.equal(withdrawn, true);
  const after = await get(); healthyPage(after);
  const lead = after.body.match(/<h1[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/)?.[1];
  assert.equal(lead, 'Fixture conservation story 2');
  results.push({ check: 'real_admin_withdrawal_retires_local_and_shared_homepage', status: 200, lead });
  databaseMode = 'slow';
  const phased = await get('/?verify=phased-budget'); healthyPage(phased);
  assert.ok(phased.durationMs < 8000, `Sequential page reads reset the deadline: ${phased.durationMs}ms`);
  results.push({ check: 'later_page_sections_share_the_original_read_deadline', status: 200, durationMs: phased.durationMs });
  assert.ok(logs.includes('public_page_cache_unavailable'));
  assert.ok(logs.includes('public_page_cache_recovered'));
  console.log(JSON.stringify({ checks: results, totalFixtureReads: reads, totalFixtureCacheRequests: cacheRequests, localFixtureWrites: fixtureWrites, externalReads: 0, externalWrites: 0 }, null, 2));
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) await writeFile(process.argv[outputIndex + 1], JSON.stringify({ checks: results, totalFixtureReads: reads, totalFixtureCacheRequests: cacheRequests, localFixtureWrites: fixtureWrites, externalReads: 0, externalWrites: 0 }, null, 2));
  if (process.argv.includes('--serve')) {
    databaseMode = 'healthy'; cacheMode = '429'; await advance(31_000);
    console.log(`Local fixture review ready: ${base}`);
    await new Promise((resolve) => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  }
} finally {
  app.kill('SIGTERM'); database.closeAllConnections(); cache.closeAllConnections();
  await Promise.all([new Promise((resolve) => database.close(resolve)), new Promise((resolve) => cache.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
