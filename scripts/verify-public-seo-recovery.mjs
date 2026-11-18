import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

// Run against a local production build. Only public Supabase reads may leave
// this process; all failure injection and browser requests stay local.
const database = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
assert.ok(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
const originalFetch = globalThis.fetch;
const fixtures = new Map();
let outage = false;
let publicReads = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  assert.equal(url.origin, database.origin, 'Unexpected external service');
  assert.ok(['GET', 'HEAD'].includes(request.method), 'Upstream writes are forbidden');
  if (outage) return new Response('{"message":"Local test outage","code":"TEST_OUTAGE"}', { status: 503, headers: { 'content-type': 'application/json' } });
  const keyUrl = new URL(url);
  for (const [key, value] of keyUrl.searchParams) if (/^lte\.\d{4}-\d{2}-\d{2}T/.test(value)) keyUrl.searchParams.set(key, 'lte.FROZEN_TEST_TIME');
  const key = `${request.method}:${keyUrl}`;
  if (!fixtures.has(key)) {
    publicReads++;
    const response = await originalFetch(request);
    const body = await response.text();
    assert.ok(response.ok, `Public database read failed: ${response.status}`);
    fixtures.set(key, { body, status: response.status, headers: [...response.headers] });
  }
  const saved = fixtures.get(key);
  return new Response(request.method === 'HEAD' ? null : saved.body, { status: saved.status, headers: saved.headers });
};
const app = (await import(pathToFileURL(resolve('.vercel/output/functions/__server.func/index.mjs')).href)).default;
const results = [];
async function request(path, options = {}, application = app) {
  const work = [];
  const response = await application.fetch(new Request(`https://news.wildteam.org.uk${path}`, { ...options, headers: { 'user-agent': 'Google-InspectionTool/1.0', ...options.headers } }), { waitUntil: (p) => work.push(p) });
  const body = await response.text();
  await Promise.allSettled(work);
  results.push({ path, method: options.method ?? 'GET', status: response.status, outage });
  return { response, body };
}
const headCanonical = (html) => html.split('</head>')[0].match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1].replaceAll('&amp;', '&');
const cardLinks = (html) => [...(html.match(/<section class="topic-page-grid shell">([\s\S]*?)<\/section>/)?.[1] ?? '').matchAll(/<a class="text-link" href="([^"]+)"/g)].map((match) => match[1]);

if (process.env.WILDNEWS_BASELINE_BUILD) {
  const baseline = (await import(pathToFileURL(resolve(process.env.WILDNEWS_BASELINE_BUILD)).href)).default;
  outage = true;
  assert.ok([200, 503].includes((await request('/topics/wildlife?recovery-test=baseline', {}, baseline)).response.status));
  outage = false;
}

const restored = await request('/tags/indigenous-peoples-and-local-communities');
assert.equal(restored.response.status, 200);
assert.ok(cardLinks(restored.body).length > 0);
assert.equal(headCanonical(restored.body), 'https://news.wildteam.org.uk/tags/indigenous-peoples-and-local-communities');
const sitemap = await request('/sitemap.xml');
assert.equal(sitemap.response.status, 200);
const taxonomyPaths = [...sitemap.body.matchAll(/<loc>https:\/\/news\.wildteam\.org\.uk(\/(?:topics|tags)\/[^<]+)<\/loc>/g)].map((match) => match[1]);
assert.ok(taxonomyPaths.length > 0);
// Count unique published articles independently of the archive and sitemap code.
const client = createClient(database.href, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const tagCounts = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await client.from('stories').select('id, story_tags(content_tags(slug, status))')
    .eq('status', 'published').eq('content_type', 'news').lte('published_at', new Date().toISOString())
    .order('id').range(from, from + 999);
  assert.ifError(error);
  for (const story of data) for (const link of story.story_tags) {
    const tag = Array.isArray(link.content_tags) ? link.content_tags[0] : link.content_tags;
    if (tag?.status !== 'approved') continue;
    const ids = tagCounts.get(tag.slug) ?? new Set(); ids.add(story.id); tagCounts.set(tag.slug, ids);
  }
  if (data.length < 1000) break;
}
for (const [slug, ids] of tagCounts) {
  const path = `/tags/${slug}`; const eligible = ids.size >= 20;
  assert.equal(taxonomyPaths.includes(path), eligible, `Sitemap threshold ${slug}`);
  const { response, body } = await request(path);
  assert.equal(response.status, eligible ? 200 : 404, `Archive threshold ${slug}: ${ids.size}`);
  if (!eligible) assert.match(body, /noindex/);
}
const machineIndex = await request('/llms.txt');
assert.equal(machineIndex.response.status, 200);
for (const match of machineIndex.body.matchAll(/https:\/\/news\.wildteam\.org\.uk\/tags\/([a-z0-9-]+)/g)) assert.ok(tagCounts.get(match[1])?.size >= 20, `Machine index advertises withheld tag ${match[1]}`);
for (const path of taxonomyPaths) {
  const { response, body } = await request(path);
  assert.equal(response.status, 200, `Sitemap archive ${path}`);
  assert.equal(headCanonical(body), `https://news.wildteam.org.uk${path}`);
  assert.ok(cardLinks(body).length > 0, `Empty sitemap archive ${path}`);
}
const archives = [];
for (const base of ['/topics/wildlife', '/tags/indigenous-peoples-and-local-communities']) {
  let path = base; let pages = 0; const links = [];
  do {
    const { response, body } = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(headCanonical(body), `https://news.wildteam.org.uk${path}`, path);
    assert.ok(!/data-dgst=|<main[^>]*data-public-page-unavailable/.test(body));
    assert.match(body.split('</head>')[0], /name="robots" content="index, follow"/);
    const cards = cardLinks(body); assert.ok(cards.length > 0 && cards.length <= 24);
    links.push(...cards); pages++;
    if (pages > 1) assert.match(body, /rel="prev" href="/);
    path = body.match(/rel="next" href="([^"]+)"/)?.[1].replaceAll('&amp;', '&');
    assert.ok(pages < 100, 'Pagination cycle');
  } while (path);
  assert.equal(new Set(links).size, links.length, 'Duplicate across archive pages');
  archives.push({ path: base, pages, stories: links.length });
  assert.equal((await request(`${base}?page=${pages + 1}`)).response.status, 404);
}
for (const path of ['/tags/passive-acoustic-monitoring', '/tags/recovery-test-missing', '/topics/recovery-test-missing', '/topics/wildlife?page=0', '/topics/wildlife?page=01', '/topics/wildlife?page=2&page=3']) {
  assert.equal((await request(path)).response.status, 404, path);
}
assert.equal(headCanonical((await request('/topics/wildlife?page=1')).body), 'https://news.wildteam.org.uk/topics/wildlife');
for (const slug of ['hazel-dormouse-numbers-show-a-small-recent-rise-after-long-decline', 'mura-residents-and-potash-company-dispute-reports-of-dried-springs', 'a-year-after-bais-bay-spill-communities-and-marine-habitats-show-lasting-impacts', 'african-parks-receives-4-6m-commitment-tied-to-outcomes-at-four-african-sites', 'ai-assisted-survey-maps-rare-bats-across-english-woodlands']) {
  const { response, body } = await request(`/stories/${slug}`);
  assert.equal(response.status, 200);
  for (const match of body.matchAll(/<a[^>]*href="(?:https:\/\/news\.wildteam\.org\.uk)?\/tags\/([a-z0-9-]+)/g)) assert.ok(tagCounts.get(match[1])?.size >= 20, `Link to withheld tag ${match[1]}`);
  assert.match(body, /"@type":"NewsArticle"/);
}

outage = true;
for (const path of ['/topics/wildlife?page=2', '/tags/indigenous-peoples-and-local-communities?page=2', '/stories/global-fungal-conservation-strategy-launched-at-cop17?recovery-test=outage']) {
  for (const method of ['GET', 'HEAD']) {
    const { response, body } = await request(path, { method });
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
    if (method === 'HEAD') assert.equal(body, '');
  }
}
for (const headers of [{ cookie: 'sb-fixture-auth-token=private' }, { authorization: 'Bearer fixture' }]) {
  assert.equal((await request('/topics/wildlife', { headers })).response.status, 503);
}
// Previously healthy shared snapshots remain usable during a short outage.
assert.equal((await request('/tags/indigenous-peoples-and-local-communities')).response.status, 200);
outage = false;
assert.equal((await request('/topics/wildlife?page=2')).response.status, 200);

const artifactDirectory = `/tmp/wildnews-seo-recovery-${Date.now()}`;
await mkdir(artifactDirectory);
await writeFile(`${artifactDirectory}/eligible-tag.html`, restored.body);
await writeFile(`${artifactDirectory}/results.json`, JSON.stringify({ results, archives, publicReads, upstreamWrites: 0 }, null, 2));
console.log(JSON.stringify({ checks: results.length, sitemapArchives: taxonomyPaths.length, restoredTagStories: cardLinks(restored.body).length, archives, publicReads, upstreamWrites: 0, artifactDirectory }));

if (process.argv.includes('--serve')) {
  const mime = { '.css': 'text/css', '.js': 'application/javascript', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
  createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1:3199');
    if (url.pathname === '/_review/outage') { outage = url.searchParams.get('enabled') === '1'; res.end(outage ? 'Local outage enabled' : 'Local outage cleared'); return; }
    const file = resolve('.vercel/output/static', `.${decodeURIComponent(url.pathname)}`);
    if (file.startsWith(`${resolve('.vercel/output/static')}/`)) {
      try { const body = await readFile(file); const extension = file.match(/\.[^.]+$/)?.[0]; res.writeHead(200, { 'content-type': mime[extension] ?? 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : body); return; } catch { /* Public route, not a static asset. */ }
    }
    try {
      const { response, body } = await request(url.pathname + url.search, { method: req.method, headers: { accept: req.headers.accept ?? 'text/html' } });
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(body);
    } catch { res.writeHead(500).end('Local review failed'); }
  }).listen(3199, '127.0.0.1', () => console.log('Local review: http://127.0.0.1:3199'));
}
