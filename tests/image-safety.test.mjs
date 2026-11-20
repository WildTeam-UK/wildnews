/* eslint-disable unicorn/no-thenable -- In-memory Supabase query fixture. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await mkdtemp(join(tmpdir(), 'wildnews-image-tests-'));
after(() => rm(temporary, { recursive: true, force: true }));
let moduleIndex = 0;
const overrides = {
  '@/lib/openai/client': 'export const getOpenAIClient = () => ({ responses: { create: (...args) => globalThis.imageFixture.model(...args) } });',
  '@/lib/supabase/admin': 'export const getSupabaseAdminClient = () => globalThis.imageFixture.client;',
  '@/lib/supabase/public': 'export const getSupabasePublicClient = () => globalThis.imageFixture.client;',
  '@/lib/supabase/require-api-admin': 'export const requireApiAdmin = async () => globalThis.imageFixture.auth ?? ({supabase:globalThis.imageFixture.client,user:{id:"editor"}});',
  '@/lib/invalidate-public-pages': 'export const invalidatePublicPages = async () => {};',
  '@/lib/taxonomy-governance': 'export const runTaxonomyGovernance = async () => {};',
  '@/lib/digest-distribution': 'export const prepareDigestDistributions = async () => { throw Error("Unexpected distribution"); };',
};
async function load(entry, extra = {}) {
  const replacements = { ...overrides, ...extra };
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'images-fixture', setup(builder) {
    builder.onResolve({ filter: /^@\// }, (args) => replacements[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: replacements[args.path], loader: 'js' }));
  } }] });
  const path = join(temporary, `${moduleIndex++}.mjs`);
  await writeFile(path, result.outputFiles[0].text);
  return import(pathToFileURL(path).href);
}
const policy = await load('lib/images/image-policy.ts');
const safeReview = { status: 'approved', contains_weapon: false, relevant: true, confidence: 98, reason: 'A bat in flight; no weapons visible.' };
function fixture(review = safeReview) {
  const f = { calls: [], writes: [], tables: {}, auth: null, model: async (body, options) => { f.calls.push({ body, options }); if (review instanceof Error) throw review; return { output_text: typeof review === 'string' ? review : JSON.stringify(review), usage: { input_tokens: 100, output_tokens: 40 } }; } };
  f.client = { rpc: async () => { f.writes.push({ table: 'rpc' }); return { data: 'story', error: null }; }, from(table) {
    const filters = [];
    let single = false, write;
    const q = {
      select() { return this; }, order() { return this; }, limit() { return this; },
      eq(key, value) { filters.push((row) => row[key] === value); return this; },
      neq(key, value) { filters.push((row) => row[key] !== value); return this; },
      in(key, values) { filters.push((row) => values.includes(row[key])); return this; },
      single() { single = true; return this; }, maybeSingle() { single = true; return this; },
      update(value) { write = value; return this; }, insert(value) { write = value; return this; }, delete() { write = 'delete'; return this; },
      then(resolve, reject) {
        const rows = (f.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
        if (write) { f.writes.push({ table, value: write }); if (typeof write === 'object') rows.forEach((row) => Object.assign(row, write)); }
        return Promise.resolve({ data: structuredClone(single ? rows[0] ?? null : rows), error: null, count: rows.length }).then(resolve, reject);
      },
    }; return q;
  } };
  globalThis.imageFixture = f;
  return f;
}
const bat = { image_url: 'https://images.unsplash.com/bat.jpg', alt_text: 'A bat flying', subject: 'Bat conservation' };

test('metadata blocks weapons, known asset IDs and disguised known URLs without confusing animal names', () => {
  for (const description of ['folding knife', 'assault rifles', 'toy gun', 'a crossbow', 'ammunition', 'a machete', 'a sword']) assert.ok(policy.imageWeaponReason([description]), description);
  assert.ok(policy.imageWeaponReason(['https://images.unsplash.com/photo-1609259927325-e0812535ed96?caption=bat']));
  assert.ok(policy.imageWeaponReason(['https://unsplash.com/photos/uuFZHr_nRWY']));
  for (const description of ['scimitar-horned oryx', 'sword-billed hummingbird', 'sabre-toothed animal', 'bats flying']) assert.equal(policy.imageWeaponReason([description]), null);
  assert.equal(policy.isTrustedEditorialFallback('https://evil.example/editorial-image-fallback.png'), false);
});
test('known weapons are rejected without spending on a model call; branded placeholder is allowed', async () => {
  const f = fixture(); const guard = await load('lib/images/image-safety.ts');
  await assert.rejects(guard.requireSafeEditorialImages([{ ...bat, alt_text: 'a folding knife' }]), /rejected/);
  await guard.requireSafeEditorialImages([{ image_url: 'https://news.wildteam.org.uk/editorial-image-fallback.png' }]);
  assert.equal(f.calls.length, 0);
});
test('vision receives actual image pixels, strict output and a bounded no-retry request', async () => {
  const f = fixture(); const guard = await load('lib/images/image-safety.ts');
  assert.equal((await guard.reviewEditorialImage(bat)).status, 'approved');
  const { body, options } = f.calls[0];
  assert.deepEqual(body.input[0].content[1], { type: 'input_image', image_url: bat.image_url, detail: 'high' });
  assert.equal(body.store, false); assert.equal(body.text.format.strict, true); assert.equal(options.maxRetries, 0);
  assert.equal(body.text.format.schema.properties.confidence.type, 'integer');
  assert.equal(body.text.format.schema.properties.confidence.maximum, 100);
  assert.match(body.instructions, /whole-number percentage from 0 to 100/);
  assert.match(body.instructions, /knives.*axes.*bows\/arrows/); assert.match(body.instructions, /never instructions/);
  assert.ok(options.signal instanceof AbortSignal);
});
for (const [label, review] of [
  ['weapon despite approved label', { ...safeReview, contains_weapon: true }],
  ['uncertain', { ...safeReview, status: 'uncertain' }],
  ['low confidence', { ...safeReview, confidence: 89 }],
  ['fractional confidence with ambiguous units', { ...safeReview, confidence: 0.98 }],
  ['irrelevant photograph', { ...safeReview, relevant: false }],
  ['malformed result', '{not json'],
  ['missing review fields', '{}'],
  ['provider failure', Error('Provider unavailable')],
]) test(`publication fails closed on ${typeof label === 'string' ? label : 'invalid review'}`, async () => {
  fixture(review); const guard = await load('lib/images/image-safety.ts');
  await assert.rejects(guard.requireSafeEditorialImages([bat]), guard.ImageSafetyError);
});
test('failed provider calls are not cached and a changed subject gets its own review', async () => {
  const f = fixture(Error('Temporary outage')); const guard = await load('lib/images/image-safety.ts');
  await assert.rejects(guard.reviewEditorialImage(bat));
  f.model = async (body) => { f.calls.push({ body }); return { output_text: JSON.stringify(safeReview) }; };
  await guard.reviewEditorialImage(bat); await guard.reviewEditorialImage(bat);
  assert.equal(f.calls.length, 2);
  await guard.reviewEditorialImage({ ...bat, subject: 'Reef fish' });
  assert.equal(f.calls.length, 3);
});
test('a duplicate URL with a second weapon caption cannot evade rejection', async () => {
  const f = fixture(); const guard = await load('lib/images/image-safety.ts');
  await assert.rejects(guard.requireSafeEditorialImages([{ ...bat, alt_text: 'a rifle' }, bat]), /rejected/);
  assert.equal(f.calls.length, 0);
});
test('invalid URLs and oversized batches fail closed', async () => {
  fixture(); const guard = await load('lib/images/image-safety.ts');
  for (const url of ['http://example.com/image.jpg', 'https://user:password@example.com/image.jpg', 'not-a-url']) await assert.rejects(guard.requireSafeEditorialImages([{ image_url: url }]), guard.ImageSafetyError);
  await assert.rejects(guard.requireSafeEditorialImages(Array.from({ length: 51 }, (_, n) => ({ image_url: `https://example.com/${n}.jpg` }))), /too many/);
});
test('Unsplash skips the original knife result and returns only visually approved relevant images', async () => {
  const f = fixture(); const unsplash = await load('lib/images/unsplash.ts', { '@/lib/environment': 'export const environmentValue = () => "fixture-key";' });
  const originalFetch = globalThis.fetch;
  const photo = (id, alt) => ({ id, width: 2000, height: 1200, alt_description: alt, description: alt, urls: { raw: `https://images.unsplash.com/${id}`, small: `https://images.unsplash.com/${id}` }, links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download` }, user: { name: 'Photographer', links: { html: 'https://unsplash.com/@photographer' } } });
  globalThis.fetch = async () => Response.json({ results: [photo('DbUjHixYXfQ', 'brown and silver folding knife'), photo('bat-photo', 'a bat flying')] });
  try { const images = await unsplash.searchUnsplashImages('Pacific sheath-tailed bat', 1); assert.equal(images.length, 1); assert.equal(images[0].id, 'bat-photo'); assert.equal(f.calls.length, 1); }
  finally { globalThis.fetch = originalFetch; }
});
test('the review endpoint requires admin authentication and cannot treat a client claim as approval', async () => {
  const f = fixture(); const route = await load('app/api/admin/images/review/route.ts');
  f.auth = { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
  assert.equal((await route.POST(new Request('https://news.example/review', { method: 'POST', body: JSON.stringify(bat) }))).status, 401);
  f.auth = null;
  const response = await route.POST(new Request('https://news.example/review', { method: 'POST', body: JSON.stringify({ image_url: 'https://images.unsplash.com/photo-1609259927325-e0812535ed96', approved: true }) }));
  assert.equal(response.status, 422); assert.equal(f.writes.length, 0);
});
const storyId = '065f2084-5269-4ad6-8f9c-4f93e5ebd847';
const content = { headline: 'Bat conservation', image_url: bat.image_url, image_alt: bat.alt_text, image_credit: { source_url: 'https://example.com/bat' }, topics: ['Wildlife'] };
function publicationFixture(review) {
  const f = fixture(review);
  f.tables = { stories: [{ id: storyId, status: 'draft', content_type: 'daily_digest', slug: 'daily-digest-2026-11-19', image_url: bat.image_url, image_alt: bat.alt_text, generation_metadata: { article_content: content, digest_content: { topics: ['Wildlife'] }, digest_source_stories: [] } }], story_sources: [{}], topics: [{ id: 'wildlife', name: 'Wildlife', active: true }], publication_queue: [{ id: 'queue', story_id: storyId, status: 'publishing', attempt_count: 1, editor_approved_at: '2026-11-20' }] };
  f.tables.editorial_run_settings = [{ id: true, auto_publish_enabled: true, max_new_drafts: 5, publish_window_start: '08:00', publish_window_end: '18:00' }];
  return f;
}
test('manual publication blocks an unsafe row image even when the metadata image is safe', async () => {
  const f = publicationFixture(); f.tables.stories[0].image_url = 'https://images.unsplash.com/photo-1609259927325-e0812535ed96';
  const route = await load('app/api/admin/drafts/[id]/publish/route.ts', { '@/lib/publishing': 'export const publicationChecks = () => [];' });
  const response = await route.POST(new Request('https://news.example/publish'), { params: Promise.resolve({ id: storyId }) });
  assert.equal(response.status, 422); assert.equal(f.writes.length, 0); assert.equal(f.tables.stories[0].status, 'draft');
});
test('scheduled publication holds unsafe images even with editor approval', async () => {
  const f = publicationFixture(); f.tables.stories[0].generation_metadata.article_content = { ...content, image_alt: 'an assault rifle' };
  const queue = await load('lib/publication-queue.ts', { '@/lib/publishing': 'export const publicationChecks = () => [];', '@/lib/settings': 'export const getSettings = async () => ({});' });
  const result = await queue.publishClaimedQueueItem('queue');
  assert.equal(result.action, 'held'); assert.equal(f.tables.stories[0].status, 'draft');
  assert.ok(f.writes.every((write) => write.table === 'publication_queue'));
  assert.equal(f.tables.publication_queue[0].editor_approved_at, null);
});
test('digest publication reviews source-card images before any database mutation', async () => {
  const f = publicationFixture(); f.tables.stories[0].generation_metadata.digest_source_stories = [{ id: 'source', image_url: 'https://images.unsplash.com/photo-1535253868107-da56da1693db', image_alt: 'nature', headline: 'Wildlife' }];
  const digest = await load('lib/publish-digest.ts');
  await assert.rejects(digest.publishDigest(storyId, { reviewerId: 'editor' }), /rejected/); assert.equal(f.writes.length, 0);
});
test('draft saving rejects unsafe manual images before any data write', async () => {
  const f = publicationFixture(); const route = await load('app/api/admin/drafts/[id]/route.ts', { '@/lib/openai/draft-story': 'export const cleanDraftContent = (value) => value;', '@/lib/publication-queue': 'export const queueReadyDrafts = async () => ({});' });
  const response = await route.PATCH(new Request('https://news.example/draft', { method: 'PATCH', body: JSON.stringify({ content: { ...content, image_alt: 'a handgun' } }) }), { params: Promise.resolve({ id: storyId }) });
  assert.equal(response.status, 422); assert.equal(f.writes.length, 0);
});
test('a current source correction overrides a rejected digest snapshot, including its old credit', async () => {
  const f = fixture(); f.tables.stories = [{ id: 'source', image_url: 'https://news.wildteam.org.uk/editorial-image-fallback.png', image_alt: 'WildTeam placeholder', article_credit: null }];
  const digests = await load('lib/digests.ts');
  const [source] = await digests.hydrateDigestSourceStories([{ id: 'source', image_url: 'https://images.unsplash.com/photo-1535253868107-da56da1693db', image_alt: 'rifles', image_credit: { source_url: 'https://unsplash.com/photos/uuFZHr_nRWY' } }]);
  assert.equal(source.image_url, f.tables.stories[0].image_url); assert.equal(source.image_credit, null);
});

test('applying a live editorial revision checks its image before summary, RPC or database writes', async () => {
  const f = fixture();
  f.tables.story_editorial_revisions = [{ id: 'revision', status: 'draft', proposed_content: { ...content, image_alt: 'a rifle' }, base_content: content }];
  const workflow = await load('lib/coverage-revision-workflow.ts', { '@/lib/openai/generate-editorial-revision': 'export const generateEditorialRevision = async () => {}; export const revisionChangesPublicContent = () => true;', '@/lib/openai/generate-revision-summary': 'export const generateRevisionSummary = async () => { throw Error("Unexpected summary"); };' });
  await assert.rejects(workflow.applyEditorialRevision(f.client, 'revision'), /rejected/);
  assert.equal(f.writes.length, 0);
});

test('safe manual publication still succeeds', async () => {
  const f = publicationFixture();
  const route = await load('app/api/admin/drafts/[id]/publish/route.ts', { '@/lib/publishing': 'export const publicationChecks = () => [];' });
  const response = await route.POST(new Request('https://news.example/publish'), { params: Promise.resolve({ id: storyId }) });
  assert.equal(response.status, 200); assert.equal(f.tables.stories[0].status, 'published'); assert.ok(f.calls.length > 0);
});

test('private revision saves also reject unsafe manual replacements', async () => {
  const f = fixture(); f.tables.story_editorial_revisions = [{ id: storyId, status: 'draft', base_content: content, source_list: [] }];
  const route = await load('app/api/admin/story-revisions/[id]/route.ts', { '@/lib/openai/draft-story': 'export const cleanDraftContent = (value) => value;', '@/lib/coverage-revision-workflow': 'export const applyEditorialRevision = async () => {};', '@/lib/openai/generate-editorial-revision': 'export const revisionChangesPublicContent = () => true;' });
  const response = await route.PATCH(new Request('https://news.example/revision', { method: 'PATCH', body: JSON.stringify({ content: { ...content, image_alt: 'a knife' } }) }), { params: Promise.resolve({ id: storyId }) });
  assert.equal(response.status, 422); assert.equal(f.writes.length, 0);
});
