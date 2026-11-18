/* oxlint-disable unicorn/no-thenable -- Supabase's query builder is awaitable. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'wildnews-archives-'));
after(() => rm(directory, { recursive: true, force: true }));
async function load(entry) {
  const compiled = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'archive-fixture', setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, ({ path }) => ({ path, namespace: 'navigation' }));
    builder.onLoad({ filter: /.*/, namespace: 'navigation' }, () => ({ contents: 'export const notFound = () => { throw Error("Not found"); };', loader: 'js' }));
    // Metadata tests do not mount the UI. The built-server integration check
    // exercises the real components, styles and framework render separately.
    builder.onResolve({ filter: /^@\/components\// }, ({ path }) => ({ path, namespace: 'components' }));
    builder.onLoad({ filter: /.*/, namespace: 'components' }, () => ({ contents: 'export const EditorialArchiveCard = () => null, EditorialPageEnd = () => null, ArchiveHero = () => null, InteriorHeader = () => null, StoryTags = () => null, TopicTag = () => null, InlineBrand = () => null, ArchivePagination = () => null;', loader: 'js' }));
    builder.onResolve({ filter: /^@\/lib\/supabase\/public$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const getSupabasePublicClient = () => globalThis.archiveFixture.client;', loader: 'js' }));
  } }] });
  const path = join(directory, `${entry.replace(/\W/g, '_')}.mjs`);
  await writeFile(path, compiled.outputFiles[0].text);
  return import(pathToFileURL(path).href);
}
const published = await load('lib/published-stories.ts');
const pagination = await load('lib/archive-pagination.ts');
const tagPage = await load('app/tags/[tag]/page.tsx');
const topicPage = await load('app/topics/[topic]/page.tsx');

function fixture() {
  const f = { calls: [], failure: null, stories: Array.from({ length: 350 }, (_, index) => ({
    id: String(350 - index).padStart(4, '0'), slug: `fixture-${index}`, status: 'published', published_at: '2026-01-01T00:00:00Z',
    headline: `Story ${index}`, standfirst: 'Fixture summary', content_type: index % 10 ? 'news' : 'daily_digest',
    story_topics: [{ topics: { name: 'Wildlife', slug: 'wildlife' } }],
    story_tags: [{ confidence: 1, content_tags: { name: index >= 344 ? 'Old tag' : 'Busy tag', slug: index >= 344 ? 'old-tag' : 'busy-tag', status: 'approved' } }],
    article_topics: ['Wildlife'], digest_topics: [],
  })) };
  f.stories.push({ ...f.stories[0], id: 'future', slug: 'future', published_at: '2999-01-01T00:00:00Z' }, { ...f.stories[0], id: 'draft', slug: 'draft', status: 'draft' });
  const archives = {
    topics: [{ name: 'Wildlife', slug: 'wildlife', active: true }, { name: 'Inactive', slug: 'inactive', active: false }],
    content_tags: [{ name: 'Old tag', slug: 'old-tag', status: 'approved' }, { name: 'Busy tag', slug: 'busy-tag', status: 'approved' }, { name: 'Proposed', slug: 'proposed', status: 'proposed' }, { name: 'Empty', slug: 'empty', status: 'approved' }],
  };
  f.client = { from(table) {
    const call = { table, filters: [], orders: [] }; f.calls.push(call);
    const q = {
      select(columns, options) { call.columns = columns; call.options = options; return this; },
      eq(key, value) { call.filters.push([key, value, 'eq']); return this; },
      lte(key, value) { call.filters.push([key, value, 'lte']); return this; },
      order(key, options) { call.orders.push([key, options]); return this; },
      range(from, to) { call.range = [from, to]; return this; },
      limit(limit) { call.range = [0, limit - 1]; return this; },
      maybeSingle() { call.single = true; return this; },
      then(resolve, reject) {
        if (f.failure && table === 'stories' && (!f.failure.rowsOnly || !call.options?.head)) return Promise.resolve({ data: null, error: { message: 'Injected database failure' } }).then(resolve, reject);
        let rows = table === 'stories' ? f.stories : archives[table] ?? [];
        rows = rows.filter((row) => call.filters.every(([key, value, operation]) => {
          if (key === 'archive_match.topics.slug') return row.story_topics.some((link) => link.topics.slug === value);
          if (key === 'archive_match.content_tags.slug') return row.story_tags.some((link) => link.content_tags.slug === value);
          return operation === 'lte' ? row[key] <= value : row[key] === value;
        }));
        const count = rows.length;
        rows = [...rows].sort((a, b) => { for (const [key, { ascending }] of call.orders) { const result = String(a[key]).localeCompare(String(b[key])); if (result) return ascending ? result : -result; } return 0; });
        if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
        return Promise.resolve({ data: call.options?.head ? null : call.single ? rows[0] ?? null : structuredClone(rows), count, error: null }).then(resolve, reject);
      },
    }; return q;
  } };
  globalThis.archiveFixture = f;
  return f;
}

test('a populated tag beyond the newest 200 stories is restored', async () => {
  fixture();
  const oldWindow = await published.getPublishedStories(200);
  assert.equal(oldWindow.some((story) => published.publishedTags(story).some((tag) => tag.slug === 'old-tag')), false);
  const archive = await published.getPublishedArchive('tags', 'old-tag', 1);
  assert.equal(archive.total, 6);
  assert.equal(archive.stories.length, 6);
});

for (const [kind, slug, count] of [['topics', 'wildlife', 350], ['tags', 'busy-tag', 344]]) test(`${kind}: every published record is reachable exactly once across stable pages`, async () => {
  const f = fixture(); const ids = [];
  for (let page = 1; page <= Math.ceil(count / 24); page++) {
    const result = await published.getPublishedArchive(kind, slug, page);
    assert.equal(result.total, count); assert.ok(result.stories.length <= 24);
    ids.push(...result.stories.map((story) => story.id));
  }
  assert.equal(ids.length, count); assert.equal(new Set(ids).size, count);
  assert.ok(!ids.includes('future') && !ids.includes('draft'));
  assert.equal(ids[0], '0350');
  for (const q of f.calls.filter((call) => call.table === 'stories' && call.range)) {
    assert.match(q.columns, /archive_match:story_(topics|tags)!inner/);
    assert.deepEqual(q.orders, [['published_at', { ascending: false }], ['id', { ascending: false }]]);
    assert.equal(q.range[1] - q.range[0], 23);
  }
});

test('missing, proposed, inactive, empty and out-of-range archives stay unavailable without a large offset', async () => {
  const f = fixture();
  for (const [kind, slug, page] of [['tags', 'missing', 1], ['tags', 'proposed', 1], ['topics', 'inactive', 1], ['tags', 'empty', 1], ['topics', 'wildlife', 1000000], ['topics', 'wildlife', 0]]) {
    assert.equal(await published.getPublishedArchive(kind, slug, page), null);
  }
  assert.equal(f.calls.some((q) => q.range), false);
});

for (const rowsOnly of [false, true]) test(`database ${rowsOnly ? 'page' : 'count'} failures propagate instead of becoming false 404s`, async () => {
  const f = fixture(); f.failure = { rowsOnly };
  await assert.rejects(published.getPublishedArchive('topics', 'wildlife', 1), { message: 'Injected database failure' });
});

test('pagination rejects malformed and unsafe values and canonicalises page one', () => {
  for (const value of ['', '0', '-1', '01', '1.5', 'Infinity', '2e2', ['2', '3'], '9007199254740991']) assert.equal(pagination.archivePageNumber(value), null);
  assert.equal(pagination.archivePageNumber(undefined), 1); assert.equal(pagination.archivePageNumber('2'), 2);
  assert.equal(pagination.archivePagePath('/topics/wildlife', 1), '/topics/wildlife');
  assert.equal(pagination.archivePagePath('/topics/wildlife', 2), '/topics/wildlife?page=2');
});

for (const [module, kind, key, slug] of [[tagPage, 'tags', 'tag', 'busy-tag'], [topicPage, 'topics', 'topic', 'wildlife']]) test(`${kind} metadata self-canonicalises each page and noindexes invalid pages`, async () => {
  fixture();
  for (const page of [undefined, '1', '2']) {
    const metadata = await module.generateMetadata({ params: Promise.resolve({ [key]: slug }), searchParams: Promise.resolve({ page }) });
    assert.equal(metadata.alternates.canonical, `/${kind}/${slug}${page === '2' ? '?page=2' : ''}`);
    if (page === '2') assert.match(metadata.title, /Page 2 \| WILDNEWS$/);
  }
  for (const page of ['0', '9999']) {
    const metadata = await module.generateMetadata({ params: Promise.resolve({ [key]: slug }), searchParams: Promise.resolve({ page }) });
    assert.deepEqual(metadata.robots, { index: false, follow: false });
  }
});
